import { TronWeb } from 'tronweb';

const NILE_RPC = process.env.NILE_RPC_URL || 'https://api.nileex.io';

let tronWebInstance: TronWeb | null = null;

export function getTronWebInstance(): TronWeb {
  if (!tronWebInstance) {
    tronWebInstance = new TronWeb({
      fullHost: NILE_RPC,
    });
    // Set a default address so that contract read calls (.call()) function correctly
    const defaultAddress = process.env.WARM_WALLET_ADDRESS;
    if (!defaultAddress) {
      throw new Error('WARM_WALLET_ADDRESS environment variable must be defined in the .env file.');
    }
    tronWebInstance.setAddress(defaultAddress);
  }
  return tronWebInstance;
}

/**
 * Fetch the USDT (TRC-20) token balance for a given address on Nile Testnet.
 * @param walletAddress Base58 TRON address (e.g. Warm Wallet)
 * @param contractAddress Base58 TRON TRC-20 contract address
 * @returns Balance in USDT (scaled from 6 decimals)
 */
export async function getUSDTBalance(
  walletAddress: string,
  contractAddress: string
): Promise<number> {
  try {
    const tronWeb = getTronWebInstance();
    // Use TronWeb contract function builder
    const contract = await tronWeb.contract().at(contractAddress);
    const balanceBig = await contract.balanceOf(walletAddress).call({
      from: walletAddress,
    });
    
    // TRC-20 USDT uses 6 decimals (Sun representation)
    const balance = Number(balanceBig.toString()) / 1_000_000;
    return balance;
  } catch (error) {
    console.error(`Error querying USDT balance for ${walletAddress}:`, error);
    // If it fails (e.g., rate limits, network down, contract not active), return a default dummy value
    // or let it propagate. We will return 0 and log it.
    return 0;
  }
}

/**
 * Fetch transaction status and confirmation details on-chain.
 * @param txHash Transaction ID string
 * @returns Transaction details including status
 */
export async function getTransactionDetails(txHash: string) {
  try {
    const tronWeb = getTronWebInstance();
    const tx = await tronWeb.trx.getTransaction(txHash);
    const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
    
    return {
      exists: !!tx,
      confirmed: !!txInfo && Object.keys(txInfo).length > 0,
      success: !!txInfo && txInfo.receipt?.result === 'SUCCESS',
      blockNumber: txInfo?.blockNumber || null,
      contractResult: txInfo?.contractResult || null,
    };
  } catch (error) {
    console.error(`Error fetching transaction details for ${txHash}:`, error);
    return null;
  }
}
