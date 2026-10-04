// Deployment owner configures an HTTPS backend here after it is ready.
// Leave empty for the public free edition: the browser cannot collect payments.
export const paidConfig = Object.freeze({
  apiBase: '',
  paidSiteUrl: '',
  chainId: 56,
  chainHex: '0x38',
  networkName: 'BNB Smart Chain 主网',
  recipient: '0x7C4383da12264BeD66D125EF34d4a4A8Bb8979F2',
  priceBnb: '0.001',
  priceWei: '1000000000000000',
  firstFree: true,
  trialPolicy: 'once_per_wallet',
});
