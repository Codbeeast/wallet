import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import http from 'http';
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import dbConnect from '../lib/db';
import ReplenishmentLogBEP20 from '../models/ReplenishmentLogBEP20';
import SystemConfigBEP20 from '../models/SystemConfigBEP20';
import DaemonLogBEP20 from '../models/DaemonLogBEP20';

// Color codes
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

const BSC_RPC = process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/';
const WARM_WALLET = process.env.BSC_WARM_WALLET_ADDRESS as string;
const USDT_CONTRACT = process.env.BSC_USDT_CONTRACT_ADDRESS as string;

if (!WARM_WALLET || !USDT_CONTRACT) {
  console.error('\x1b[31m[BSC DAEMON] [ERROR] BSC_WARM_WALLET_ADDRESS and BSC_USDT_CONTRACT_ADDRESS must be defined in .env.\x1b[0m');
  process.exit(1);
}

// Minimal ERC-20 ABI for Transfer event
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(BSC_RPC);

async function logEvent(message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
  try {
    await DaemonLogBEP20.create({ message, type });
    const consoleColor = { info: cyan, success: green, warn: yellow, error: red }[type];
    console.log(`${consoleColor}[BSC DAEMON] [${type.toUpperCase()}] ${message}${reset}`);
  } catch (err) {
    console.error('Failed to save BSC daemon log to database:', err);
  }
}

/**
 * Core verification logic for a specific BSC transaction hash.
 * Fetches the receipt, decodes the Transfer event, and validates:
 * - Transaction succeeded (status 1)
 * - Token contract matches our USDT contract
 * - Recipient matches our Warm Wallet
 * - Amount matches the PROCESSING log in the DB
 */
async function verifyTransaction(txHash: string): Promise<boolean> {
  try {
    await logEvent(`Analyzing BSC transaction: ${txHash.slice(0, 12)}... on-chain`, 'info');

    // 1. Fetch transaction receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      await logEvent(`Transaction receipt not found. May still be pending or unconfirmed.`, 'info');
      return false;
    }

    // Check EVM execution status: 1 = success, 0 = reverted
    if (receipt.status !== 1) {
      await logEvent(`Transaction execution failed on-chain. Receipt status: ${receipt.status} (REVERTED)`, 'error');
      await ReplenishmentLogBEP20.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `On-chain execution reverted. EVM status: ${receipt.status}` }
      );
      return true;
    }

    // 2. Verify the transaction targeted our USDT contract
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      await logEvent(`Transaction body not found or malformed.`, 'error');
      return false;
    }

    if (tx.to?.toLowerCase() !== USDT_CONTRACT.toLowerCase()) {
      await logEvent(`Token contract mismatch! Tx target: ${tx.to}, Expected USDT: ${USDT_CONTRACT}`, 'error');
      await ReplenishmentLogBEP20.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Contract mismatch: tx called ${tx.to} instead of USDT contract.` }
      );
      return true;
    }

    // 3. Decode Transfer event from receipt logs
    const iface = new ethers.Interface(ERC20_ABI);
    let transferLog: { from: string; to: string; amount: bigint } | null = null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDT_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === 'Transfer') {
          transferLog = {
            from: parsed.args[0] as string,
            to: parsed.args[1] as string,
            amount: parsed.args[2] as bigint,
          };
          break;
        }
      } catch {
        // Not a Transfer event, skip
      }
    }

    if (!transferLog) {
      await logEvent(`No Transfer event found in transaction logs for USDT contract.`, 'error');
      await ReplenishmentLogBEP20.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: 'No Transfer event found in transaction receipt logs.' }
      );
      return true;
    }

    const { from, to, amount } = transferLog;
    const amountUSDT = parseFloat(ethers.formatUnits(amount, 18));

    // 4. Verify recipient is our Warm Wallet
    if (to.toLowerCase() !== WARM_WALLET.toLowerCase()) {
      await logEvent(`Recipient mismatch! Transfer went to: ${to}, Expected Warm Wallet: ${WARM_WALLET}`, 'error');
      await ReplenishmentLogBEP20.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Destination mismatch: transfer sent to ${to} instead of Warm Wallet.` }
      );
      return true;
    }

    // 5. Find matching PROCESSING log in DB
    const logDoc = await ReplenishmentLogBEP20.findOne({ txHash, status: 'PROCESSING' });
    if (!logDoc) {
      await logEvent(`No PROCESSING log document found for transaction: ${txHash}. May have already been handled.`, 'warn');
      return true;
    }

    // 6. Verify amount matches
    const expectedAmountWei = BigInt(logDoc.amount);
    if (amount !== expectedAmountWei) {
      const expectedUSDT = parseFloat(ethers.formatUnits(expectedAmountWei, 18));
      await logEvent(`Amount mismatch! On-chain: ${amountUSDT.toFixed(2)} USDT, DB expected: ${expectedUSDT.toFixed(2)} USDT`, 'error');
      await ReplenishmentLogBEP20.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Amount mismatch: on-chain was ${amountUSDT.toFixed(2)} USDT, expected ${expectedUSDT.toFixed(2)} USDT.` }
      );
      return true;
    }

    // 7. All validations passed — settle
    await logEvent(`Validation passed. Setting replenishment log status to SUCCESS.`, 'success');

    logDoc.status = 'SUCCESS';
    logDoc.fromAddress = from;
    await logDoc.save();

    // Update platform balance
    const systemConfig = await SystemConfigBEP20.findOne({ key: 'bsc_platform_config' });
    if (systemConfig) {
      systemConfig.platformBalance += amountUSDT;
      systemConfig.lastUpdated = new Date();
      await systemConfig.save();
      await logEvent(`Platform balance updated. New Balance: ${systemConfig.platformBalance.toFixed(2)} USDT`, 'success');
    }

    await logEvent(`Mutex lock released. BSC system unlocked and ready.`, 'success');
    return true;
  } catch (error: any) {
    console.error('[BSC DAEMON] Error during transaction verification:', error);
    await logEvent(`Error verifying transaction: ${error.message || error}`, 'error');
    return false;
  }
}

/**
 * Real-time listener using ethers Contract event subscription.
 * Subscribes to Transfer events on the USDT contract and filters for 
 * transfers to our Warm Wallet that match active PROCESSING logs.
 */
async function startRealtimeListener() {
  try {
    await logEvent(`Initializing BSC Transfer event subscription on USDT Contract: ${USDT_CONTRACT}`, 'info');

    const contract = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, provider);

    // Listen only for transfers TO our warm wallet
    contract.on('Transfer', async (_from: string, to: string, _amount: bigint, event: ethers.EventLog) => {
      if (to.toLowerCase() !== WARM_WALLET.toLowerCase()) return;

      const txHash = event.transactionHash;
      await logEvent(`[REALTIME] Transfer event detected to Warm Wallet. txHash: ${txHash.slice(0, 12)}...`, 'info');

      const matchingLog = await ReplenishmentLogBEP20.findOne({ txHash, status: 'PROCESSING' });
      if (matchingLog) {
        await logEvent(`[REALTIME] Matched active PROCESSING txHash: ${txHash.slice(0, 12)}...`, 'info');
        await verifyTransaction(txHash);
      }
    });

    await logEvent(`BSC Transfer event subscription active. Listening for warm wallet deposits...`, 'info');
  } catch (error: any) {
    console.error('[BSC DAEMON] Failed to start real-time event watcher:', error);
    await logEvent(`Real-time subscription error: ${error.message}. Relying on polling fallback.`, 'warn');
  }
}

/**
 * Polling fallback loop — guarantees delivery even if WebSocket events are missed.
 * Checks every 6 seconds (BSC average block time: ~3 seconds).
 */
async function startPollingLoop() {
  setInterval(async () => {
    try {
      const processingLogs = await ReplenishmentLogBEP20.find({ status: 'PROCESSING' });

      if (processingLogs.length > 0) {
        await logEvent(`[POLLER] Found ${processingLogs.length} active replenishment(s) in PROCESSING state. Querying BSC node...`, 'info');

        for (const log of processingLogs) {
          await verifyTransaction(log.txHash);
        }
      }
    } catch (error) {
      console.error('[BSC DAEMON] Error in poller loop:', error);
    }
  }, 6000); // Poll every 6 seconds (BSC blocks ~3s)
}

/**
 * Daemon startup
 */
async function main() {
  await dbConnect();
  await logEvent(`Aegis BSC Deposit Listener Daemon initialized successfully.`, 'info');
  await logEvent(`Config — RPC Host: ${BSC_RPC}, Warm Wallet: ${WARM_WALLET}`, 'info');

  await startRealtimeListener();
  await startPollingLoop();

  // Dummy HTTP server for hosting platforms that require port binding
  const PORT = process.env.BSC_DAEMON_PORT || process.env.PORT || 10001;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ONLINE', service: 'Aegis BSC Deposit Listener Daemon' }));
  });

  server.listen(PORT, () => {
    logEvent(`BSC Daemon health check server listening on port ${PORT}`, 'info');
  });

  await logEvent(`BSC safety monitoring fully armed. Listening for BEP-20 replenishments...`, 'success');
}

main().catch((err) => {
  console.error('[BSC DAEMON] Startup failed:', err);
  process.exit(1);
});

// Clean shutdown
process.on('SIGINT', async () => {
  console.log('\n[BSC DAEMON] Gracefully shutting down...');
  await mongoose.disconnect();
  console.log('[BSC DAEMON] MongoDB disconnected. Goodbye!');
  process.exit(0);
});