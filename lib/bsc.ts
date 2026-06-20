import { ethers } from 'ethers';

const BSC_RPC = process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/';

// Minimal ERC-20 / BEP-20 ABI — only the methods we actually call
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

let providerInstance: ethers.JsonRpcProvider | null = null;

/**
 * Returns a cached ethers.JsonRpcProvider connected to the BSC RPC endpoint.
 */
export function getBSCProvider(): ethers.JsonRpcProvider {
  if (!providerInstance) {
    providerInstance = new ethers.JsonRpcProvider(BSC_RPC);
  }
  return providerInstance;
}

/**
 * Fetch the BEP-20 USDT token balance for a given address.
 * Returns the balance in human-readable USDT (scaled from 18 decimals).
 */
export async function getBSCUSDTBalance(
  walletAddress: string,
  contractAddress: string
): Promise<number> {
  try {
    const provider = getBSCProvider();
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, provider);
    const rawBalance: bigint = await contract.balanceOf(walletAddress);
    // BEP-20 USDT on BSC uses 18 decimals
    const balance = Number(ethers.formatUnits(rawBalance, 18));
    return balance;
  } catch (error) {
    console.error(`[BSC] Error querying USDT balance for ${walletAddress}:`, error);
    return 0;
  }
}

/**
 * Fetch transaction receipt and confirmation status on BSC.
 */
export async function getBSCTransactionDetails(txHash: string) {
  try {
    const provider = getBSCProvider();
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return {
        exists: false,
        confirmed: false,
        success: false,
        blockNumber: null,
      };
    }

    return {
      exists: true,
      confirmed: receipt.blockNumber !== null,
      // EVM: status 1 = success, 0 = reverted
      success: receipt.status === 1,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error(`[BSC] Error fetching transaction details for ${txHash}:`, error);
    return null;
  }
}

/**
 * Parse a Transfer event log from a BSC USDT transaction.
 * Returns { from, to, amount (in Wei as bigint) } or null if not a valid Transfer.
 */
export function parseBEP20TransferLog(
  log: ethers.Log,
  contractAddress: string
): { from: string; to: string; amount: bigint } | null {
  try {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) return null;

    const iface = new ethers.Interface(ERC20_ABI);
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });

    if (!parsed || parsed.name !== 'Transfer') return null;

    return {
      from: parsed.args[0] as string,
      to: parsed.args[1] as string,
      amount: parsed.args[2] as bigint,
    };
  } catch {
    return null;
  }
}
