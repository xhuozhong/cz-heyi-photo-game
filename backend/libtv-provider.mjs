import { spawn } from 'node:child_process';
import { access, readFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './store.mjs';

// LibTV's official CLI owns submission and waits for the terminal result.
// There are no invented HTTP endpoints, detached runs, timeouts or auto-retries.
export function parseCliJson(output) {
  try { return JSON.parse(output.trim()); } catch {}
  const items = output.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  if (items.length) return items.at(-1);
  throw new Error('LibTV returned an unreadable response');
}

export function runLibtvCli(cliPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) overflow = true;
      if (!overflow) stdout += chunk;
    });
    // Drain CLI progress without leaking credentials, media URLs or user photos.
    child.stderr.on('data', () => {});
    child.once('error', () => reject(new Error('LibTV CLI is unavailable')));
    child.once('close', code => {
      if (code !== 0 || overflow) reject(new Error('LibTV CLI operation failed'));
      else {
        try { resolve(parseCliJson(stdout)); }
        catch (error) {
          // Official download prints a saved-file message (or nothing), rather
          // than JSON. Exit zero is only its transport result: download() still
          // requires exactly one local image, and saveResult decodes it later.
          if (args[0] === 'download') resolve({ success: true });
          else reject(error);
        }
      }
    });
  });
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2));
}
function nodeKey(result) {
  if (Array.isArray(result)) return nodeKey(result[0]);
  return result?.nodeKey || result?.newNodeKey || result?.node?.nodeKey || result?.nodes?.[0]?.nodeKey;
}
function safeId(value) {
  if (!/^[a-f0-9-]{32,36}$/i.test(String(value))) throw new Error('Invalid provider order');
  return value;
}
function isFailed(result) {
  return result?.success === false || /^(failed|failure|error|cancelled|canceled)$/i.test(String(result?.status || ''));
}

export function makePaidPhotoPrompt(job, playerNode, referenceNode) {
  const companion = job.character === 'cz'
    ? 'CZ / Changpeng Zhao，灰黑短发、细框眼镜、黑色T恤'
    : '何一 / He Yi，黑色长发、唇下小痣、酒红色无袖连衣裙';
  const scene = {
    terrace: '城市天台的柔和晚霞，远处城市天际线',
    cafe: '窗边咖啡馆，柔和自然日光',
    street: '现代城市街道，自然傍晚光线'
  }[job.scene] || '自然日光下的城市环境';
  const outfit = { black: '黑色', cream: '米白色', red: '酒红色' }[job.options?.outfit] || '黑色';
  const garment = job.options?.gender === 'female' ? '自然得体的无袖连衣裙' : '自然得体的T恤';
  const body = { slim: '偏瘦', full: '丰满', standard: '标准' }[job.options?.body] || '标准';
  return `生成一张真实摄影风格的虚构纪念合照。玩家身份来自 {{Node ${playerNode}}}；伙伴身份来自 {{Node ${referenceNode}}}。
恰好两位前景人物：玩家与${companion}。保留玩家原本的脸型、五官、年龄、肤色、发型及可识别特征，不混脸、不换成另一个人。参考表可能包含多个角度、文字和细节面板，只提取该人物身份，不复制面板、标题或多个分身。
两人自然并肩站在${scene}，朝同一相机微笑，视线和透视一致。玩家采用${body}身材、${outfit}${garment}，保持适合原图年龄的衣着。取景到腰部或胸部，横向4:3。
从头到肩颈与身体整体自然生成：下巴、脖子、肩膀及胸骨方向协调，颈长正常，不歪脖、不拉长、不拼接、不重复领口。匹配两人的光线、阴影、镜头和色温。真实皮肤纹理、清晰眼睛、自然发丝、合理手指与服装纹理。不可生成剪贴拼图、人物参考表、宣传海报或商业代言文字。`;
}

export class LibtvProvider {
  constructor(config = {}, { run = runLibtvCli } = {}) {
    this.rootDir = path.resolve(config.rootDir || process.cwd());
    this.dataDir = path.resolve(config.dataDir || path.join(this.rootDir, 'paid-data'));
    this.cliPath = config.cliPath || path.join(os.homedir(), '.libtv', process.platform === 'win32' ? 'libtv.exe' : 'libtv');
    this.model = config.model || 'General image Pro';
    this.enabled = config.enabled === true;
    this.projectUuid = config.projectUuid || process.env.LIBTV_PROJECT_UUID;
    this.accountId = config.accountId || process.env.LIBTV_ACCOUNT_ID;
    this.generationBudget = Number(config.generationBudget ?? process.env.LIBTV_GENERATION_BUDGET ?? 0);
    this.run = args => run(this.cliPath, args, this.dataDir);
    this.budgetQueue = Promise.resolve();
  }

  async project() {
    if (!this.projectUuid) {
      const binding = await readJson(path.join(this.rootDir, '.libtv', 'project.json'));
      this.projectUuid = binding?.projectUuid;
    }
    if (!/^[a-f0-9-]{32,36}$/i.test(String(this.projectUuid))) throw new Error('No configured LibTV canvas');
    return this.projectUuid;
  }

  async budget() {
    const state = await readJson(path.join(this.dataDir, 'provider-budget.json')) || { started: [] };
    if (!Array.isArray(state.started)) throw new Error('Invalid LibTV budget journal');
    return state;
  }

  async preflight() {
    const unavailable = reason => ({ ready: false, reason, provider: 'libtv' });
    if (!this.enabled) return unavailable('AI 合影暂未开放');
    if (!Number.isSafeInteger(this.generationBudget) || this.generationBudget < 1) {
      return unavailable('AI 服务暂未开放，请稍后再试');
    }
    try {
      await mkdir(this.dataDir, { recursive: true });
      const used = await this.budget();
      const remainingGenerations = this.generationBudget - used.started.length;
      if (remainingGenerations < 1) return unavailable('本期 AI 合影名额已用完');
      await access(this.cliPath);
      await access(path.join(this.rootDir, 'public', 'assets', 'cz-reference.jpg'));
      await access(path.join(this.rootDir, 'public', 'assets', 'heyi-reference.jpg'));
      const account = await this.run(['account', 'info']);
      if (!account?.user?.id || !account?.activeAccount?.isActive || account?.activeAccount?.memberAccount?.effective !== true) {
        return unavailable('AI 服务暂时不可用，请稍后再试');
      }
      if (this.accountId && String(account.activeAccount.accountId) !== String(this.accountId)) {
        return unavailable('AI 服务配置需要检查，请稍后再试');
      }
      const model = await this.run(['model', this.model]);
      const properties = model?.schema?.properties;
      const ratios = properties?.ratio?.enum?.map(v => typeof v === 'string' ? v : v.value) || [];
      if (model?.modality !== 'image' || !properties?.modeType?.items?.image2image || !ratios.includes('4:3') || !properties?.quality?.enum?.includes('2K')) {
        return unavailable('AI 生成模型暂时不可用，请稍后再试');
      }
      const project = await this.project();
      const canvas = await this.run(['node', 'list', '-p', project]);
      if (canvas?.projectUuid !== project) return unavailable('AI 生成服务暂时不可用，请稍后再试');
      // CLI 1.1.3 has no live balance endpoint. This is an explicitly configured
      // administrator budget, not a claim that membership proves credit balance.
      return { ready: true, provider: 'libtv', remainingGenerations, quotaMode: 'administrator-budget' };
    } catch { return unavailable('AI 服务尚未就绪，请稍后再试'); }
  }

  async consumeBudget(id) {
    const operation = this.budgetQueue.then(async () => {
      const state = await this.budget();
      if (state.started.includes(id)) throw new Error('This generation was already submitted');
      if (state.started.length >= this.generationBudget) throw new Error('No reserved LibTV capacity');
      state.started.push(id);
      await atomicJson(path.join(this.dataDir, 'provider-budget.json'), state);
    });
    this.budgetQueue = operation.catch(() => {});
    return operation;
  }

  journal(job) { return path.join(path.resolve(job.outputDir), 'libtv-provider-state.json'); }

  async submit(job) {
    safeId(job.id);
    if (!['cz', 'heyi'].includes(job.character)) throw new Error('Invalid companion');
    const file = this.journal(job);
    const previous = await readJson(file);
    if (previous) {
      if (previous.status === 'succeeded' || previous.status === 'failed') return { providerJobId: previous.nodeName };
      throw new Error('Existing submission requires review; generation was not repeated');
    }
    const readiness = await this.preflight();
    if (!readiness.ready) throw new Error(readiness.reason);
    const project = await this.project();
    const state = { nodeName: `paid-result-${job.id}`, status: 'preparing', id: job.id };
    await atomicJson(file, state);
    try {
      const reference = await this.run(['upload', `paid-ref-${job.character}-${job.id}`, '-p', project, '-f', path.join(this.rootDir, 'public', 'assets', `${job.character}-reference.jpg`), '-t', 'image']);
      const player = await this.run(['upload', `paid-player-${job.id}`, '-p', project, '-f', path.resolve(job.inputPath), '-t', 'image']);
      const referenceKey = nodeKey(reference), playerKey = nodeKey(player);
      if (!referenceKey || !playerKey) throw new Error('LibTV upload did not return resource nodes');
      const created = await this.run(['node', 'create', state.nodeName, '-p', project, '-t', 'image',
        '-s', `model=${this.model}`, '-s', 'modeType=image2image', '-s', 'ratio=4:3', '-s', 'quality=2K', '-s', 'count=1',
        '--left', playerKey, '--left', referenceKey, '--prompt', makePaidPhotoPrompt(job, playerKey, referenceKey)]);
      state.nodeKey = nodeKey(created) || state.nodeName;
      // Persist capacity and submission intent before the only billable command.
      await this.consumeBudget(job.id);
      state.status = 'run_intent';
      await atomicJson(file, state);
      const terminal = await this.run(['node', state.nodeKey, '-p', project, '--run']);
      if (isFailed(terminal)) {
        state.status = 'failed';
        state.reason = 'AI 未生成完成，订单已保留等待处理';
      } else {
        state.status = 'succeeded';
        state.resultPath = await this.download(state.nodeKey, job);
      }
      await atomicJson(file, state);
      return { providerJobId: state.nodeName };
    } catch (error) {
      // Even if a command fails before returning its terminal result, never run
      // it twice. A completed remote result can be recovered read-only later.
      state.status = 'review_required';
      state.reason = 'AI 订单需要人工检查，不会重复收款或自动再次生图';
      await atomicJson(file, state);
      throw new Error(state.reason);
    }
  }

  async download(node, job) {
    const output = path.join(path.resolve(job.outputDir), 'libtv-download');
    await mkdir(output, { recursive: true });
    await this.run(['download', '-p', await this.project(), '-n', node, '-o', output]);
    const files = await readdir(output, { withFileTypes: true });
    const images = files.filter(file => file.isFile() && /\.(png|jpe?g|webp)$/i.test(file.name));
    if (images.length !== 1) throw new Error('Expected one completed LibTV image');
    return path.join(output, images[0].name);
  }

  async poll(providerJobId, job) {
    const state = await readJson(this.journal(job));
    if (!state || providerJobId !== state.nodeName) return { status: 'failed', reason: '无法定位原生图订单' };
    if (state.status === 'succeeded' && state.resultPath) {
      await access(state.resultPath);
      return { status: 'succeeded', resultPath: state.resultPath };
    }
    if (state.status === 'failed' || state.status === 'review_required') return { status: 'failed', reason: state.reason };
    return { status: 'pending' };
  }

  async recover(job) {
    const state = await readJson(this.journal(job));
    if (!state) return null;
    if (state.status === 'succeeded' || state.status === 'failed') return { providerJobId: state.nodeName };
    // One read-only lookup/download on recovery. It never triggers --run.
    try {
      const lookup = await this.run(['node', state.nodeKey || state.nodeName, '-p', await this.project()]);
      if (!nodeKey(lookup)) return null;
      state.resultPath = await this.download(state.nodeKey || state.nodeName, job);
      state.status = 'succeeded';
      await atomicJson(this.journal(job), state);
      return { providerJobId: state.nodeName };
    } catch { return null; }
  }
}

export function createLibtvProvider(config) { return new LibtvProvider(config); }
