import dbConnect from './db';
import SystemConfigBEP20 from '@/models/SystemConfigBEP20';

export async function getBSCSystemConfig() {
  await dbConnect();

  const warmWalletAddress = process.env.BSC_WARM_WALLET_ADDRESS;
  const usdtContractAddress = process.env.BSC_USDT_CONTRACT_ADDRESS;
  const coldTreasuryAddress = process.env.BSC_COLD_TREASURY_ADDRESS;

  if (!warmWalletAddress || !usdtContractAddress || !coldTreasuryAddress) {
    throw new Error(
      'CRITICAL BSC CONFIGURATION ERROR: BSC_WARM_WALLET_ADDRESS, BSC_USDT_CONTRACT_ADDRESS, and BSC_COLD_TREASURY_ADDRESS environment variables must be defined in the .env file.'
    );
  }

  let config = await SystemConfigBEP20.findOne({ key: 'bsc_platform_config' });
  if (!config) {
    const lowFundsThreshold = parseFloat(process.env.BSC_LOW_FUNDS_THRESHOLD || '15000.00');

    config = await SystemConfigBEP20.create({
      key: 'bsc_platform_config',
      platformBalance: 10240.50,
      lowFundsThreshold,
      warmWalletAddress,
      usdtContractAddress,
      coldTreasuryAddress,
    });
  } else {
    let modified = false;
    if (config.warmWalletAddress !== warmWalletAddress) {
      config.warmWalletAddress = warmWalletAddress;
      modified = true;
    }
    if (config.usdtContractAddress !== usdtContractAddress) {
      config.usdtContractAddress = usdtContractAddress;
      modified = true;
    }
    if (config.coldTreasuryAddress !== coldTreasuryAddress) {
      config.coldTreasuryAddress = coldTreasuryAddress;
      modified = true;
    }
    if (modified) {
      await config.save();
      console.log('[BSC] Database system config addresses updated to match current .env settings.');
    }
  }

  return config;
}
