import 'dotenv/config'; // Loads .env values
import mongoose from 'mongoose';
import { TronWeb } from 'tronweb';
import dbConnect from '../lib/db';
import ReplenishmentLog from '../models/ReplenishmentLog';
import SystemConfig from '../models/SystemConfig';
import DaemonLog from '../models/DaemonLog';

// Color codes for console logs
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

const NILE_RPC = process.env.NILE_RPC_URL || 'https://api.nileex.io';
const WARM_WALLET = process.env.WARM_WALLET_ADDRESS;
const USDT_CONTRACT = process.env.USDT_CONTRACT_ADDRESS;

if (!WARM_WALLET || !USDT_CONTRACT) {
  console.error('\x1b[31m[DAEMON] [ERROR] WARM_WALLET_ADDRESS and USDT_CONTRACT_ADDRESS environment variables must be defined in the .env file.\x1b[0m');
  process.exit(1);
}

// Initialize TronWeb
const tronWeb = new TronWeb({
  fullHost: NILE_RPC,
});

async function logEvent(message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
  try {
    await DaemonLog.create({ message, type });
    const consoleColor = {
      info: cyan,
      success: green,
      warn: yellow,
      error: red,
    }[type];
    console.log(`${consoleColor}[DAEMON] [${type.toUpperCase()}] ${message}${reset}`);
  } catch (err) {
    console.error('Failed to save daemon log to database:', err);
  }
}

/**
 * Parses a TRON transaction's contract data to verify TRC-20 USDT transfer details.
 * ABI method signature for transfer: transfer(address,uint256) -> method id: a9059cbb
 */
function parseTRC20Transfer(txDataHex: string) {
  try {
    if (!txDataHex || !txDataHex.startsWith('a9059cbb')) {
      return null;
    }
    
    // Address parameter is at offset 8 (after 4-byte method selector) padded to 32 bytes
    // Address is in the lower 20 bytes: index 32 to 72
    const addressHex = '41' + txDataHex.substring(32, 72); // 41 is TRON base58 prefix in hex
    const toAddress = tronWeb.address.fromHex(addressHex);
    
    // Amount parameter is at offset 72 padded to 32 bytes
    const amountHex = txDataHex.substring(72, 136);
    const amountSun = parseInt(amountHex, 16);
    
    return {
      toAddress,
      amountSun,
    };
  } catch (error) {
    console.error('Failed to parse raw TRC-20 transfer input data:', error);
    return null;
  }
}

/**
 * Core verification logic for a specific transaction hash
 */
async function verifyTransaction(txHash: string) {
  try {
    await logEvent(`Analyzing transaction: ${txHash.slice(0, 10)}... on-chain`, 'info');
    
    // 1. Fetch transaction receipt info (status check)
    const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
    if (!txInfo || Object.keys(txInfo).length === 0) {
      await logEvent(`Transaction info not found yet. It may still be unconfirmed or pending block finalization.`, 'info');
      return false;
    }
    
    // Check execution status
    const isSuccess = txInfo.receipt?.result === 'SUCCESS';
    if (!isSuccess) {
      await logEvent(`Transaction execution failed on-chain. Receipt result: ${txInfo.receipt?.result || 'FAILED'}`, 'error');
      
      // Update DB log to FAILED
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `On-chain execution failed: ${txInfo.receipt?.result || 'UNKNOWN_ERROR'}` }
      );
      
      await logEvent(`Released mutex lock and set log status to FAILED.`, 'warn');
      return true;
    }
    
    // 2. Fetch raw transaction data (address and amount check)
    const tx = await tronWeb.trx.getTransaction(txHash);
    if (!tx || !tx.raw_data || !tx.raw_data.contract || tx.raw_data.contract.length === 0) {
      await logEvent(`Transaction body not found or malformed.`, 'error');
      return false;
    }
    
    const contractObject = tx.raw_data.contract[0];
    if (contractObject.type !== 'TriggerSmartContract') {
      await logEvent(`Invalid transaction type: expected TriggerSmartContract, got ${contractObject.type}`, 'error');
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: 'Invalid transaction type: not a smart contract call.' }
      );
      return true;
    }
    
    const contractValue = contractObject.parameter.value as any;

    // Verify it called the correct USDT contract address
    const contractAddressHex = contractValue.contract_address;
    const contractAddress = tronWeb.address.fromHex(contractAddressHex);
    
    if (contractAddress !== USDT_CONTRACT) {
      await logEvent(`Token address mismatch! Transaction target: ${contractAddress}, Expected USDT Contract: ${USDT_CONTRACT}`, 'error');
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Token mismatch: transaction target ${contractAddress} is not the configured USDT contract.` }
      );
      return true;
    }
    
    // Parse target address and amount from transfer data input
    const inputDataHex = contractValue.data;
    const parsedTransfer = parseTRC20Transfer(inputDataHex);
    
    if (!parsedTransfer) {
      await logEvent(`Could not parse TRC-20 transfer parameters from transaction input.`, 'error');
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: 'Failed to parse transfer method details from input data.' }
      );
      return true;
    }
    
    const { toAddress, amountSun } = parsedTransfer;
    const amountUSDT = amountSun / 1_000_000;
    
    // 3. Verify recipient address matches Warm Wallet Address
    if (toAddress.toLowerCase() !== WARM_WALLET.toLowerCase()) {
      await logEvent(`Recipient address mismatch! Target: ${toAddress}, Expected Warm Wallet: ${WARM_WALLET}`, 'error');
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Destination address mismatch: transaction sent to ${toAddress} instead of Warm Wallet.` }
      );
      return true;
    }
    
    // 4. Find matching processing log
    const logDoc = await ReplenishmentLog.findOne({ txHash, status: 'PROCESSING' });
    if (!logDoc) {
      await logEvent(`No processing log document found for transaction: ${txHash}. It may have already been handled.`, 'warn');
      return true;
    }
    
    // Verify amount matches
    if (amountSun !== logDoc.amount) {
      await logEvent(`Amount mismatch! Blockchain transferred: ${amountUSDT} USDT, Database requested: ${logDoc.amount / 1_000_000} USDT`, 'error');
      await ReplenishmentLog.findOneAndUpdate(
        { txHash, status: 'PROCESSING' },
        { status: 'FAILED', error: `Amount mismatch: on-chain was ${amountUSDT} USDT, expected ${logDoc.amount / 1_000_000} USDT.` }
      );
      return true;
    }
    
    // 5. Successful validation - settle balance sheet and log
    await logEvent(`Validation passed. Settiing replenishment log status to SUCCESS.`, 'success');
    
    logDoc.status = 'SUCCESS';
    const ownerAddress = contractValue.owner_address;
    logDoc.fromAddress = ownerAddress 
      ? tronWeb.address.fromHex(ownerAddress)
      : 'Unknown Cold Wallet';
    await logDoc.save();
    
    // Update platform balance
    const systemConfig = await SystemConfig.findOne({ key: 'platform_config' });
    if (systemConfig) {
      systemConfig.platformBalance += amountUSDT;
      systemConfig.lastUpdated = new Date();
      await systemConfig.save();
      await logEvent(`Platform balance sheet updated. New Balance: ${systemConfig.platformBalance} USDT`, 'success');
    }
    
    await logEvent(`Mutex lock released. System unlocked.`, 'success');
    return true;
  } catch (error: any) {
    console.error('Error during transaction verification:', error);
    await logEvent(`Error verifying transaction: ${error.message || error}`, 'error');
    return false;
  }
}

/**
 * Real-time event listener subscription using TronWeb contract event watch
 */
async function startRealtimeListener() {
  try {
    await logEvent(`Initializing event subscription on USDT Contract: ${USDT_CONTRACT}`, 'info');
    
    // Load contract interface
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    
    if (contract && typeof contract.Transfer === 'function') {
      contract.Transfer().watch(async (err: any, eventResult: any) => {
        if (err) {
          console.error('Error in TRON event subscription:', err);
          return;
        }
        
        if (eventResult && eventResult.transaction) {
          const txHash = eventResult.transaction;
          
          // Check if this txHash matches a transaction we are actively PROCESSING
          const matchingLog = await ReplenishmentLog.findOne({ txHash, status: 'PROCESSING' });
          if (matchingLog) {
            await logEvent(`[REALTIME] Intercepted Transfer event matching active txHash: ${txHash.slice(0, 10)}...`, 'info');
            await verifyTransaction(txHash);
          }
        }
      });
      await logEvent(`USDT contract Transfer event subscription active.`, 'info');
    } else {
      await logEvent(`Could not bind Event Watch: contract or Transfer method not available. Falling back to active poll.`, 'warn');
    }
  } catch (error: any) {
    console.error('Failed to establish real-time event watcher:', error);
    await logEvent(`Real-time subscription connection error: ${error.message || error}. Running in polling mode.`, 'warn');
  }
}

/**
 * Continuous polling fallback loop to guarantee delivery of processing events
 */
async function startPollingLoop() {
  setInterval(async () => {
    try {
      // Find all logs that are currently in PROCESSING state
      const processingLogs = await ReplenishmentLog.find({ status: 'PROCESSING' });
      
      if (processingLogs.length > 0) {
        await logEvent(`[POLLER] Found ${processingLogs.length} active replenishment(s) in PROCESSING state. Querying node pool...`, 'info');
        
        for (const log of processingLogs) {
          await verifyTransaction(log.txHash);
        }
      }
    } catch (error) {
      console.error('Error in poller loop:', error);
    }
  }, 6000); // Poll every 6 seconds (TRON average block time is 3 seconds)
}

/**
 * Startup initialization
 */
async function main() {
  await dbConnect();
  await logEvent(`Aegis Deposit Listener Daemon initialized successfully.`, 'info');
  await logEvent(`Environment configuration - RPC Host: ${NILE_RPC}, Warm Wallet: ${WARM_WALLET}`, 'info');
  
  // Start real-time subscription
  await startRealtimeListener();
  
  // Start backup poller
  await startPollingLoop();
  
  await logEvent(`Safety monitoring loops fully armed. Listening for refills...`, 'success');
}

main().catch((err) => {
  console.error('Daemon startup failed:', err);
  process.exit(1);
});

// Clean shutdown handler
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down deposit listener daemon...');
  await mongoose.disconnect();
  console.log('MongoDB disconnected. Goodbye!');
  process.exit(0);
});
