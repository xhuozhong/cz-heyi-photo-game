// GitHub Pages hosts the game; the owner's HTTPS API handles AI orders.
// The frontend verifies live service readiness before allowing wallet actions.
export const paidConfig = Object.freeze({
  apiBase: 'https://xhuozhong.com',
  paidSiteUrl: '',
  chainId: 56,
  chainHex: '0x38',
  networkName: 'BNB Smart Chain 主网',
  recipient: '0xdC0A1628203953EB54Cb8649B0b0C228b1364f95',
  priceBnb: '0.001',
  priceWei: '1000000000000000',
  firstFree: true,
  trialPolicy: 'once_per_wallet',
});
