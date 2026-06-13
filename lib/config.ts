import dbConnect from './db';
import SystemConfig from '@/models/SystemConfig';

export async function getSystemConfig() {
  await dbConnect();
  
  const warmWalletAddress = process.env.WARM_WALLET_ADDRESS;
  const usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS;
  const coldTreasuryAddress = process.env.COLD_TREASURY_ADDRESS;

  if (!warmWalletAddress || !usdtContractAddress || !coldTreasuryAddress) {
    throw new Error(
      'CRITICAL CONFIGURATION ERROR: WARM_WALLET_ADDRESS, USDT_CONTRACT_ADDRESS, and COLD_TREASURY_ADDRESS environment variables must be defined in the .env file.'
    );
  }

  let config = await SystemConfig.findOne({ key: 'platform_config' });
  if (!config) {
    const lowFundsThreshold = parseFloat(process.env.LOW_FUNDS_THRESHOLD || '15000.00');

    config = await SystemConfig.create({
      key: 'platform_config',
      platformBalance: 10240.50, // Initial seed balance
      lowFundsThreshold,
      warmWalletAddress,
      usdtContractAddress,
      coldTreasuryAddress,
    });
  } else {
    // Keep database config updated if .env values change (removes need for hardcoded migration paths)
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
      console.log('Database system config addresses updated to match current .env settings.');
    }
  }
  return config;
}
