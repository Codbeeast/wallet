'use client';

import React, { useState, useEffect, useRef } from 'react';

// Declarations for TronLink's window object
declare global {
  interface Window {
    tronWeb?: any;
  }
}

interface ReplenishmentLog {
  _id: string;
  txHash: string;
  amount: number;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
  fromAddress?: string;
  toAddress?: string;
  error?: string;
  createdAt: string;
}

interface DaemonLog {
  _id: string;
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
  createdAt: string;
}

export default function Dashboard() {
  // App settings & metrics
  const [platformBalance, setPlatformBalance] = useState<number>(10240.50);
  const [lowFundsThreshold, setLowFundsThreshold] = useState<number>(15000.00);
  const [warmWalletAddress, setWarmWalletAddress] = useState<string>('');
  const [usdtContractAddress, setUsdtContractAddress] = useState<string>('');
  const [warmWalletBalanceOnChain, setWarmWalletBalanceOnChain] = useState<number>(0);
  const [isLowFunds, setIsLowFunds] = useState<boolean>(true);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [activeLockTxHash, setActiveLockTxHash] = useState<string | null>(null);
  
  // Lists
  const [logs, setLogs] = useState<ReplenishmentLog[]>([]);
  const [daemonLogs, setDaemonLogs] = useState<DaemonLog[]>([]);
  
  // UI control states
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [amountInput, setAmountInput] = useState<string>('5000');
  const [txHashInput, setTxHashInput] = useState<string>(''); // For manual overrides
  
  // Transaction lifecycle stages
  // idle -> connecting -> usb_bridge -> ledger_review -> signing -> broadcasting -> db_lock -> daemon_check -> finished -> error
  const [step, setStep] = useState<'idle' | 'connecting' | 'usb_bridge' | 'ledger_review' | 'signing' | 'broadcasting' | 'db_lock' | 'daemon_check' | 'finished' | 'error'>('idle');
  const [stepMessage, setStepMessage] = useState<string>('');
  const [currentTxHash, setCurrentTxHash] = useState<string>('');
  const [activeLedgerScreen, setActiveLedgerScreen] = useState<number>(0); // 0: Connect, 1: Review, 2: Amount, 3: Address, 4: Sign
  
  // Real TronWeb connection state
  const [tronAddress, setTronAddress] = useState<string>('');
  const [tronLinkDetected, setTronLinkDetected] = useState<boolean>(false);
  const [tronLinkConnected, setTronLinkConnected] = useState<boolean>(false);

  // Terminal container scroll reference
  const terminalContainerRef = useRef<HTMLDivElement>(null);

  // Fetch status and logs on mount and poll
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const json = await res.json();
      if (json.success) {
        setPlatformBalance(json.data.platformBalance);
        setLowFundsThreshold(json.data.lowFundsThreshold);
        setWarmWalletAddress(json.data.warmWalletAddress);
        setUsdtContractAddress(json.data.usdtContractAddress);
        setWarmWalletBalanceOnChain(json.data.warmWalletBalanceOnChain);
        setIsLowFunds(json.data.isLowFunds);
        setIsLocked(json.data.isLocked);
        setActiveLockTxHash(json.data.activeLockTxHash);
        setLogs(json.data.logs);
      }
    } catch (err) {
      console.error('Error fetching status data:', err);
    }
  };

  const fetchDaemonLogs = async () => {
    try {
      const res = await fetch('/api/simulate-daemon');
      const json = await res.json();
      if (json.success) {
        setDaemonLogs(json.logs);
      }
    } catch (err) {
      console.error('Error fetching daemon logs:', err);
    }
  };

  // Poll databases
  useEffect(() => {
    fetchStatus();
    fetchDaemonLogs();
    
    const statusInterval = setInterval(fetchStatus, 3000);
    const logsInterval = setInterval(fetchDaemonLogs, 1500);
    
    return () => {
      clearInterval(statusInterval);
      clearInterval(logsInterval);
    };
  }, []);

  // Detect TronLink
  useEffect(() => {
    const checkTronWeb = () => {
      if (typeof window !== 'undefined' && window.tronWeb) {
        setTronLinkDetected(true);
        if (window.tronWeb.defaultAddress && window.tronWeb.defaultAddress.base58) {
          setTronAddress(window.tronWeb.defaultAddress.base58);
          setTronLinkConnected(true);
        }
      } else {
        setTronLinkDetected(false);
      }
    };

    checkTronWeb();
    // Add interval checking because TronWeb injection can be delayed
    const detectInterval = setInterval(checkTronWeb, 1000);
    return () => clearInterval(detectInterval);
  }, []);

  // Auto Scroll Terminal to Bottom (container-only scroll, preserving page scroll)
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [daemonLogs]);

  // Connect to TronLink (Live mode)
  const connectTronLink = async (): Promise<string> => {
    if (typeof window === 'undefined' || !window.tronWeb) {
      throw new Error('TronLink extension not found. Please install and unlock the TronLink browser extension to proceed.');
    }
    
    // Check if already ready
    if (window.tronWeb.defaultAddress && window.tronWeb.defaultAddress.base58) {
      const addr = window.tronWeb.defaultAddress.base58;
      setTronAddress(addr);
      setTronLinkConnected(true);
      return addr;
    }
    
    try {
      // Prompt user to connect
      await window.tronWeb.request({ method: 'tron_requestAccounts' });
      
      // Delay briefly for injection synchronization
      await new Promise((resolve) => setTimeout(resolve, 300));
      
      if (window.tronWeb.defaultAddress && window.tronWeb.defaultAddress.base58) {
        const addr = window.tronWeb.defaultAddress.base58;
        setTronAddress(addr);
        setTronLinkConnected(true);
        return addr;
      }
    } catch (err: any) {
      console.error('TronLink connection rejected:', err);
      throw new Error(err.message || 'Authorization request to TronLink was rejected.');
    }
    
    throw new Error('TronLink is locked or permissions were not granted. Open TronLink, log in, and try again.');
  };

  // Helper to trigger backend simulations
  const triggerSimulation = async (action: string, txHash?: string) => {
    try {
      const res = await fetch('/api/simulate-daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, txHash }),
      });
      const data = await res.json();
      fetchStatus();
      fetchDaemonLogs();
      return data;
    } catch (err) {
      console.error('Simulation command failed:', err);
    }
  };

  // RESET lifecycle back to idle
  const handleResetWorkflow = () => {
    setStep('idle');
    setStepMessage('');
    setCurrentTxHash('');
    setActiveLedgerScreen(0);
  };

  // REPLENISHMENT WORKFLOW INITIATOR
  const handleInitiateReplenishment = async () => {
    if (isLocked) {
      alert('SYSTEM LOCKED: A replenishment is already in progress. Mutex lock is active.');
      return;
    }

    const amt = parseFloat(amountInput);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid positive replenishment amount.');
      return;
    }

    if (mode === 'live') {
      await runLiveWorkflow(amt);
    } else {
      await runMockWorkflow(amt);
    }
  };

  // ----------------------------------------------------
  // 1. MOCK SIMULATOR WORKFLOW (WEBIDS + LEDGER SIGN SIMULATION)
  // ----------------------------------------------------
  const runMockWorkflow = async (amount: number) => {
    setStep('connecting');
    setStepMessage('Connecting to TronLink provider interface...');
    
    // Simulate TronLink connection delay
    setTimeout(() => {
      setStep('usb_bridge');
      setStepMessage('TronLink detected hardware key. Initializing WebHID USB communication...');
      setActiveLedgerScreen(0); // Show Connect USB screen on mockup
    }, 1200);
  };

  const handleSimulatedUSBConnect = () => {
    setStep('ledger_review');
    setStepMessage('Secure USB channel established. Reviewing transaction details on Ledger Nano screen...');
    setActiveLedgerScreen(1); // Review transaction
  };

  const handleLedgerNextScreen = () => {
    setActiveLedgerScreen((prev) => {
      const next = prev + 1;
      if (next === 4) {
        setStepMessage('All transaction fields verified. Press both physical buttons to generate cryptographic signature...');
      }
      return next;
    });
  };

  const handleLedgerPrevScreen = () => {
    setActiveLedgerScreen((prev) => Math.max(1, prev - 1));
  };

  const handleSimulatedSign = () => {
    setStep('signing');
    setStepMessage('ECDSA Hardware Core generating signature without exposing private key...');
    
    setTimeout(() => {
      setStep('broadcasting');
      setStepMessage('Signature relayed to TronLink. Broadcasting signed TRC-20 Transfer transaction to Nile Testnet...');
      
      // Generate a mock txHash (TRON tx hashes are 64 hex characters)
      const hexChars = '0123456789abcdef';
      let mockHash = '';
      for (let i = 0; i < 64; i++) {
        mockHash += hexChars[Math.floor(Math.random() * 16)];
      }
      
      setTimeout(async () => {
        setCurrentTxHash(mockHash);
        setStep('db_lock');
        setStepMessage('Transaction broadcasted. Submitting transaction hash to Node.js backend to acquire Mutex lock...');
        
        // POST to backend API
        try {
          const res = await fetch('/api/replenish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              txHash: mockHash,
              amount: amountInput,
              fromAddress: 'T-ColdTreasuryLedgerOfflineDevice',
            }),
          });
          const json = await res.json();
          
          if (!json.success) {
            setStep('error');
            setStepMessage(`Backend API Rejected: ${json.error}`);
            return;
          }
          
          setStep('daemon_check');
          setStepMessage('Mutex lock acquired [PROCESSING]. Daemon listening for blockchain transfer events...');
          
          // Wait 3 seconds then simulate daemon confirmation
          setTimeout(async () => {
            await triggerSimulation('confirm', mockHash);
            setStep('finished');
            setStepMessage(`Liquidity replenishment settled successfully! Platform balance updated by +${amountInput} USDT.`);
          }, 3500);
          
        } catch (error: any) {
          setStep('error');
          setStepMessage(`HTTP Connection Failed: ${error.message}`);
        }
      }, 1500);
    }, 1800);
  };


  // ----------------------------------------------------
  // 2. LIVE NETWORK WORKFLOW (REAL TRONLINK & NILE TESTNET CONTRACT)
  // ----------------------------------------------------
  const runLiveWorkflow = async (amount: number) => {
    setStep('connecting');
    setStepMessage('Requesting TronLink wallet connection...');
    
    try {
      const activeAddress = await connectTronLink();
      
      setStep('usb_bridge');
      setStepMessage(`Connected to wallet: ${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}. Preparing transaction...`);

      const tronWeb = window.tronWeb;
      
      // Construct TRC-20 transfer parameter inputs
      // We scale amount to Sun (6 decimals)
      const amountSun = Math.round(amount * 1_000_000);
      
      setStepMessage('Constructing TRC-20 transfer payload. Handing over details to TronLink/Ledger...');
      
      // Build the smart contract call transaction object
      const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
        usdtContractAddress,      // USDT Contract address
        'transfer(address,uint256)', // Function ABI signature
        {},                       // Options
        [
          { type: 'address', value: warmWalletAddress }, // Destination: Warm Wallet
          { type: 'uint256', value: amountSun }          // Amount scaled in Sun
        ],
        activeAddress             // Owner/From address (uses direct string)
      );
      
      setStep('signing');
      setStepMessage('Waiting for Ledger Nano USB WebHID confirmation and button signature authorization...');
      
      // Prompt TronLink to sign the transaction
      const signedTransaction = await tronWeb.trx.sign(transaction.transaction);
      
      setStep('broadcasting');
      setStepMessage('Broadcasting cryptographically signed transaction to Nile Testnet nodes...');
      
      // Broadcast the signed transaction directly to the Nile RPC
      const broadcastResult = await tronWeb.trx.sendRawTransaction(signedTransaction);
      
      if (!broadcastResult.result) {
        throw new Error(
          broadcastResult.code 
            ? `RPC Node Error: ${broadcastResult.code} (${String(broadcastResult.message)})` 
            : 'RPC Node rejected broadcast.'
        );
      }
      
      const realTxHash = broadcastResult.txid;
      setCurrentTxHash(realTxHash);
      
      setStep('db_lock');
      setStepMessage('Transaction broadcasted. Submitting transaction hash to Node.js backend to acquire Mutex lock...');
      
      // POST to backend API
      const res = await fetch('/api/replenish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: realTxHash,
          amount: amountInput,
          fromAddress: activeAddress,
        }),
      });
      const json = await res.json();
      
      if (!json.success) {
        setStep('error');
        setStepMessage(`Backend API Rejected: ${json.error}`);
        return;
      }
      
      setStep('daemon_check');
      setStepMessage('Mutex lock acquired [PROCESSING]. Background daemon (daemons/depositListener.ts) is watching for event confirmation...');
      
    } catch (err: any) {
      console.error(err);
      setStep('error');
      setStepMessage(`Live Transaction Failed: ${err.message || err}`);
    }
  };

  // Helper to format timestamps
  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans selection:bg-teal-500 selection:text-black antialiased">
      {/* GLOW DECORATIONS */}
      <div className="absolute top-0 left-1/4 w-[40vw] h-[40vh] bg-teal-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-[20%] right-1/4 w-[35vw] h-[35vh] bg-indigo-500/5 rounded-full blur-[100px] pointer-events-none" />

      {/* HEADER NAVBAR */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/60 backdrop-blur-xl sticky top-0 z-50 transition-all duration-300">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo Icon */}
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-emerald-400 p-[1px] shadow-lg shadow-teal-500/10">
              <div className="w-full h-full bg-[#0a0f1d] rounded-xl flex items-center justify-center">
                <span className="text-teal-400 font-black text-lg tracking-tighter">Æ</span>
              </div>
            </div>
            <div>
              <h1 className="text-md font-bold tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-zinc-50 to-zinc-300 uppercase">
                Aegis Gateway
              </h1>
              <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">Safety Mechanism</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4 font-mono text-xs">
            {/* Network Badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
              <span className="text-zinc-400">TRON Nile Testnet</span>
            </div>

            {/* TronLink Connection Badge */}
            {tronLinkConnected ? (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-950/40 border border-teal-800/60 text-teal-400">
                <span>TL Connected:</span>
                <span className="font-semibold">{tronAddress.slice(0, 5)}...{tronAddress.slice(-4)}</span>
              </div>
            ) : (
              <button 
                onClick={connectTronLink}
                className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 transition-colors text-zinc-400 cursor-pointer"
              >
                <span>TL Disconnected</span>
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-7xl mx-auto px-6 py-8 flex flex-col gap-6">
        
        {/* STATUS ALERTS BANNER */}
        <div className={`p-4 rounded-2xl border backdrop-blur-md transition-all duration-500 shadow-xl flex items-center justify-between flex-wrap gap-4 ${
          isLowFunds 
            ? 'bg-amber-950/20 border-amber-500/30 text-amber-300 shadow-amber-950/10' 
            : 'bg-emerald-950/25 border-emerald-500/30 text-emerald-400 shadow-emerald-950/10'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
              isLowFunds ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'
            }`}>
              {isLowFunds ? '!' : '✓'}
            </div>
            <div>
              <p className="font-bold text-sm uppercase tracking-wider">
                {isLowFunds ? 'Critical Alert: Platform Liquidity Low' : 'System Secure: Liquidity Level Nominal'}
              </p>
              <p className={`text-xs ${isLowFunds ? 'text-amber-400/80' : 'text-emerald-400/80'}`}>
                {isLowFunds 
                  ? `Automated server layers are at $${platformBalance.toLocaleString()} USDT, below the safety limit of $${lowFundsThreshold.toLocaleString()} USDT.`
                  : `Automated server layers are healthy at $${platformBalance.toLocaleString()} USDT (Safety Threshold: $${lowFundsThreshold.toLocaleString()} USDT).`
                }
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => triggerSimulation('trigger-funds-low')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs transition-colors cursor-pointer"
            >
              Force Low Funds
            </button>
            <button
              onClick={() => triggerSimulation('reset-balance')}
              className="px-3 py-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs transition-colors cursor-pointer"
            >
              Force Healthy
            </button>
          </div>
        </div>

        {/* METRICS GRID */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Card 1: Platform Balance */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-zinc-700 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-teal-500 to-indigo-500 opacity-60" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Platform Internal Balance</p>
            <h2 className="text-3xl font-black mt-2 font-mono text-zinc-50 group-hover:text-teal-400 transition-colors">
              ${platformBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h2>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono">Simulated database ledger balance</p>
          </div>

          {/* Card 2: Warm Wallet On Chain */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-zinc-700 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-purple-500 opacity-60" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Warm Wallet On-Chain</p>
            <h2 className="text-3xl font-black mt-2 font-mono text-zinc-50 group-hover:text-indigo-400 transition-colors">
              {warmWalletBalanceOnChain.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-zinc-400">USDT</span>
            </h2>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono truncate">Nile Address: {warmWalletAddress}</p>
          </div>

          {/* Card 3: Cold Treasury Status */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-zinc-700 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-blue-500 to-cyan-500 opacity-60" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Cold Treasury Bridge</p>
            <div className="flex items-center gap-2 mt-3">
              <div className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-pulse" />
              <h3 className="text-lg font-bold text-zinc-200">Hardware Locked</h3>
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono">Ledger Secure (WebHID Interface)</p>
          </div>

          {/* Card 4: Mutex Queue Lock */}
          <div className={`border rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden transition-all duration-500 ${
            isLocked 
              ? 'bg-red-950/15 border-red-500/40 shadow-red-950/5' 
              : 'bg-zinc-900/40 border-zinc-800/80 hover:border-zinc-700'
          }`}>
            {isLocked && <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />}
            {!isLocked && <div className="absolute top-0 left-0 w-1 h-full bg-zinc-700" />}
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Queue Mutex Lock</p>
            
            <div className="flex items-center gap-2.5 mt-3">
              <div className={`w-3 h-3 rounded-full ${isLocked ? 'bg-red-500 animate-ping' : 'bg-emerald-500'}`} />
              <span className={`text-md font-bold tracking-wide ${isLocked ? 'text-red-400 font-mono text-xs uppercase' : 'text-emerald-400'}`}>
                {isLocked ? 'MUTEX ACQUIRED (LOCKED)' : 'IDLE - READY FOR FILL'}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono truncate">
              {isLocked ? `Locked by active tx: ${activeLockTxHash?.slice(0, 12)}...` : 'No concurrent top-ups active'}
            </p>
          </div>
        </section>

        {/* REPLENISHMENT WORKFLOW & LEDGER SIMULATOR GRID */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* CONTROL & ACTION INTERFACE (LEFT SIDE) */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            
            {/* INITIATOR CARD */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md relative">
              <h3 className="text-lg font-extrabold tracking-wide mb-4 flex items-center justify-between border-b border-zinc-900 pb-3">
                <span>REPLENISHMENT CONSOLE</span>
                {/* MODE TOGGLER */}
                <div className="flex bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-xs font-mono">
                  <button 
                    onClick={() => { if (step === 'idle') setMode('mock'); }}
                    disabled={step !== 'idle'}
                    className={`px-3 py-1 rounded-md transition-all cursor-pointer ${
                      mode === 'mock' 
                        ? 'bg-teal-500 text-black font-semibold' 
                        : 'text-zinc-400 hover:text-zinc-200 disabled:opacity-40'
                    }`}
                  >
                    MOCK MODE
                  </button>
                  <button 
                    onClick={() => { if (step === 'idle') setMode('live'); }}
                    disabled={step !== 'idle'}
                    className={`px-3 py-1 rounded-md transition-all cursor-pointer ${
                      mode === 'live' 
                        ? 'bg-teal-500 text-black font-semibold' 
                        : 'text-zinc-400 hover:text-zinc-200 disabled:opacity-40'
                    }`}
                  >
                    LIVE NILE
                  </button>
                </div>
              </h3>

              {/* INPUT FIELDS */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Destination Address (Warm Wallet)</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-300">
                    <span className="flex-1 select-all">{warmWalletAddress}</span>
                    <span className="text-teal-400 text-xs uppercase font-bold">Hardcoded Server Destination</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">USDT contract address</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-400">
                    <span className="flex-1 select-all">{usdtContractAddress}</span>
                    <span className="text-indigo-400 text-xs">TRC-20 Token</span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-end mt-1">
                  <div className="flex-1 flex flex-col gap-1.5 w-full">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">USDT Replenishment Amount</label>
                    <div className="relative">
                      <input 
                        type="number"
                        disabled={step !== 'idle' || isLocked}
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        placeholder="5,000"
                        className="w-full bg-[#0b0f19] border border-zinc-800 focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 rounded-xl pl-4 pr-16 py-3 font-mono text-zinc-100 placeholder-zinc-700 outline-none transition-colors"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-xs">USDT</span>
                    </div>
                  </div>
                  
                  <button
                    onClick={handleInitiateReplenishment}
                    disabled={step !== 'idle' || isLocked || !warmWalletAddress || !usdtContractAddress}
                    className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-400 hover:to-emerald-400 text-black font-extrabold tracking-wide uppercase transition-all duration-300 shadow-lg shadow-teal-500/10 hover:shadow-teal-400/20 disabled:from-zinc-900 disabled:to-zinc-900 disabled:border-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2 h-[46px] cursor-pointer"
                  >
                    Initiate Replenishment
                  </button>
                </div>
              </div>

              {/* ARCHITECTURE WORKFLOW MAP */}
              <div className="mt-6 border-t border-zinc-900 pt-5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-3">Multi-Tier Safety Workflow States</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[9px] text-zinc-400">
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-teal-400">Tier 1: Physical</span>
                    <span>Ledger WebHID</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-indigo-400">Tier 2: Broadcast</span>
                    <span>Nile testnet RPC</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-purple-400">Tier 3: Database</span>
                    <span>Mutex status lock</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-emerald-400">Tier 4: Daemon</span>
                    <span>Event watch listener</span>
                  </div>
                </div>
              </div>
            </div>

            {/* TRANSACTION PIPELINE PROGRESS PANEL */}
            {step !== 'idle' && (
              <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md animate-fade-in">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-900 pb-3">
                  <h3 className="text-sm font-bold text-zinc-300 uppercase tracking-widest font-mono">
                    Replenishment Execution Flow
                  </h3>
                  <button 
                    onClick={handleResetWorkflow}
                    className="px-2.5 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-md bg-zinc-900 hover:bg-zinc-850 cursor-pointer"
                  >
                    Reset Console
                  </button>
                </div>

                <div className="flex flex-col gap-4 text-xs font-mono">
                  {/* Step status display */}
                  <div className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-850 p-3.5 rounded-xl">
                    <div className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-teal-500"></span>
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] text-zinc-500 uppercase">Current Stage: {step.replace('_', ' ')}</p>
                      <p className="text-zinc-200 text-xs mt-0.5">{stepMessage}</p>
                    </div>
                  </div>

                  {/* Flow pipeline visualization */}
                  <div className="flex flex-col gap-3.5 mt-2">
                    {/* Item 1: Connect Wallet */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        ['idle', 'connecting'].includes(step) ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        1
                      </div>
                      <span className={['idle', 'connecting'].includes(step) ? 'text-zinc-500' : 'text-zinc-300'}>
                        Connect TronLink Wallet
                      </span>
                    </div>

                    {/* Item 2: Physical Ledger Bridge */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        ['idle', 'connecting', 'usb_bridge'].includes(step) ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        2
                      </div>
                      <div className="flex-1 flex justify-between items-center">
                        <span className={['idle', 'connecting', 'usb_bridge'].includes(step) ? 'text-zinc-500' : 'text-zinc-300'}>
                          Ledger WebHID Handshake
                        </span>
                        {step === 'usb_bridge' && mode === 'mock' && (
                          <button 
                            onClick={handleSimulatedUSBConnect}
                            className="bg-teal-500 hover:bg-teal-400 text-black px-2.5 py-1 text-[10px] font-extrabold rounded-md shadow-md shadow-teal-500/15 cursor-pointer"
                          >
                            Simulate USB Plug
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Item 3: Hardware Signing */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        ['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing'].includes(step) ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        3
                      </div>
                      <span className={['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing'].includes(step) ? 'text-zinc-500' : 'text-zinc-300'}>
                        Ledger Verification & ECDSA Signature
                      </span>
                    </div>

                    {/* Item 4: Network Broadcast */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        ['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing', 'broadcasting'].includes(step) ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        4
                      </div>
                      <span className={['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing', 'broadcasting'].includes(step) ? 'text-zinc-500' : 'text-zinc-300'}>
                        Broadcast signed raw payload to RPC
                      </span>
                    </div>

                    {/* Item 5: Backend Lock */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        ['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing', 'broadcasting', 'db_lock'].includes(step) ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        5
                      </div>
                      <span className={['idle', 'connecting', 'usb_bridge', 'ledger_review', 'signing', 'broadcasting', 'db_lock'].includes(step) ? 'text-zinc-500' : 'text-zinc-300'}>
                        Backend Mutex Acquisition ([PROCESSING])
                      </span>
                    </div>

                    {/* Item 6: Daemon Event Confirmation */}
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        step !== 'finished' ? 'bg-zinc-800 text-zinc-500' : 'bg-teal-500 text-black'
                      }`}>
                        6
                      </div>
                      <div className="flex-1 flex justify-between items-center">
                        <span className={step !== 'finished' ? 'text-zinc-500' : 'text-zinc-300'}>
                          Event Daemon Verification & Settle
                        </span>
                        {step === 'daemon_check' && (
                          <button 
                            onClick={() => triggerSimulation('confirm', currentTxHash)}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-0.5 text-[9px] rounded cursor-pointer"
                          >
                            Force Verify Now
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Transaction details link */}
                  {currentTxHash && (
                    <div className="mt-4 pt-4 border-t border-zinc-900 text-[10px]">
                      <span className="text-zinc-500">CAPTURED HASH:</span>{' '}
                      <a 
                        href={`https://nile.tronscan.org/#/transaction/${currentTxHash}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-teal-400 hover:underline break-all font-mono"
                      >
                        {currentTxHash}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          
          {/* HARDWARE LEDGER NANO SIMULATOR (RIGHT SIDE) */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            
            {/* LEDGER 3D NANO BODY */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md flex flex-col items-center justify-center min-h-[350px]">
              <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-6 self-start">
                Offline Hardware Wallet Bridge (WebHID Interface)
              </p>

              {/* LEDGER DEVICE CASING */}
              <div className="relative w-80 bg-[#1e2025] rounded-3xl p-6 shadow-2xl border border-zinc-700/80 flex flex-col gap-5">
                
                {/* Physical buttons on top */}
                <div className="absolute top-[-8px] left-20 right-20 flex justify-between px-2">
                  {/* Left Button */}
                  <button 
                    onClick={() => {
                      if (step === 'ledger_review' && activeLedgerScreen > 1) {
                        handleLedgerPrevScreen();
                      }
                    }}
                    disabled={step !== 'ledger_review' || activeLedgerScreen <= 1}
                    className="w-10 h-3 bg-zinc-600 hover:bg-zinc-500 border-b-2 border-zinc-700 active:scale-95 rounded-t-sm transition-all shadow-md cursor-pointer disabled:opacity-40"
                    title="Ledger Left Button"
                  />
                  {/* Right Button */}
                  <button 
                    onClick={() => {
                      if (step === 'ledger_review') {
                        if (activeLedgerScreen < 4) {
                          handleLedgerNextScreen();
                        } else if (activeLedgerScreen === 4) {
                          handleSimulatedSign();
                        }
                      }
                    }}
                    disabled={step !== 'ledger_review'}
                    className="w-10 h-3 bg-zinc-600 hover:bg-zinc-500 border-b-2 border-zinc-700 active:scale-95 rounded-t-sm transition-all shadow-md cursor-pointer disabled:opacity-40"
                    title="Ledger Right Button"
                  />
                </div>

                {/* LEDGER OLED SCREEN */}
                <div className="w-full h-24 bg-[#030712] rounded-xl border-4 border-zinc-800 px-4 py-3 flex flex-col justify-between items-center text-cyan-400 font-mono select-none shadow-inner shadow-black relative overflow-hidden">
                  
                  {/* SCREEN 0: USB DISCONNECTED */}
                  {step === 'usb_bridge' && activeLedgerScreen === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-1.5 animate-pulse">
                      <span className="text-[10px] text-cyan-500 font-bold tracking-wider">AEGIS COLD KEY</span>
                      <span className="text-xs font-bold text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded">USB: WAITING HID</span>
                    </div>
                  )}

                  {/* SCREEN 1: REVIEW DETAILS */}
                  {step === 'ledger_review' && activeLedgerScreen === 1 && (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <span className="text-[10px] text-cyan-500 uppercase tracking-widest">Verify transfer</span>
                      <span className="text-xs mt-1 text-zinc-100 font-bold animate-pulse">Review on Ledger ➔</span>
                    </div>
                  )}

                  {/* SCREEN 2: REVIEW AMOUNT */}
                  {step === 'ledger_review' && activeLedgerScreen === 2 && (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <span className="text-[9px] text-cyan-500 uppercase tracking-wider">USDT AMOUNT</span>
                      <span className="text-sm font-bold text-zinc-100">{parseFloat(amountInput).toLocaleString()} USDT</span>
                    </div>
                  )}

                  {/* SCREEN 3: REVIEW DESTINATION ADDRESS */}
                  {step === 'ledger_review' && activeLedgerScreen === 3 && (
                    <div className="flex flex-col items-center justify-center h-full text-center w-full px-2">
                      <span className="text-[9px] text-cyan-500 uppercase tracking-wider">WARM WALLET ADDR</span>
                      <span className="text-[10px] font-bold text-zinc-100 break-all select-all font-mono">
                        {warmWalletAddress.slice(0, 10)}...{warmWalletAddress.slice(-10)}
                      </span>
                    </div>
                  )}

                  {/* SCREEN 4: SIGN CONFIRMATION */}
                  {step === 'ledger_review' && activeLedgerScreen === 4 && (
                    <div className="flex flex-col items-center justify-center h-full text-center animate-pulse">
                      <span className="text-[9px] text-cyan-500 uppercase tracking-widest">Authorize Sign?</span>
                      <span className="text-xs mt-1 text-emerald-400 font-black">Press Right Button ➔</span>
                    </div>
                  )}

                  {/* SIGNING GENERATION */}
                  {step === 'signing' && (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-1">
                      <span className="text-[9px] text-zinc-500 uppercase">ECDSA CRYPTO CHIP</span>
                      <span className="text-xs font-bold text-cyan-400 animate-pulse">GENERATING SIG...</span>
                    </div>
                  )}

                  {/* IDLE SCREEN */}
                  {(['idle', 'connecting', 'broadcasting', 'db_lock', 'daemon_check', 'finished', 'error'].includes(step)) && (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-0.5">
                      <span className="text-[10px] text-cyan-600 font-bold uppercase tracking-wider">Aegis Secure Hardware</span>
                      <span className="text-xs text-zinc-400 font-bold">
                        {step === 'finished' ? 'Settled ✓' : step === 'error' ? 'Sig Rejected' : 'Standby / Locked'}
                      </span>
                    </div>
                  )}

                  {/* Slide page indicators */}
                  {step === 'ledger_review' && (
                    <div className="absolute bottom-1 right-2 text-[8px] text-cyan-600">
                      {activeLedgerScreen}/4
                    </div>
                  )}
                </div>

                {/* Ledger Body Details */}
                <div className="flex justify-between items-center text-[#585c64] font-mono text-[9px]">
                  <span>Model: Nano S Plus</span>
                  <span>v2.2.1 Secure Element</span>
                </div>
              </div>

              {/* Status Hint */}
              <div className="mt-5 text-center text-xs text-zinc-500 max-w-xs font-mono">
                {step === 'usb_bridge' && mode === 'mock' && (
                  <p className="animate-pulse text-teal-400">Click the "Simulate USB Plug" button on the left panel to simulate plugging in the Ledger via WebHID.</p>
                )}
                {step === 'ledger_review' && activeLedgerScreen < 4 && (
                  <p>Click the <strong className="text-zinc-300">Right Button</strong> on top of the Ledger Nano to slide through transaction fields.</p>
                )}
                {step === 'ledger_review' && activeLedgerScreen === 4 && (
                  <p className="text-emerald-400 font-bold">Click the Right Button once more to trigger ECDSA signing on the device.</p>
                )}
                {step === 'idle' && (
                  <p>Enter an amount above and click "Initiate Replenishment" to start the signing bridge.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* DAEMON LIVE TERMINAL & LOGS */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LOGS HISTORY TABLE (LEFT SIDE) */}
          <div className="lg:col-span-7 bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md flex flex-col">
            <h3 className="text-sm font-bold tracking-widest text-zinc-300 uppercase mb-4 border-b border-zinc-900 pb-3 flex justify-between items-center font-mono">
              <span>Replenishment Audits & Mutex Logs</span>
              <button 
                onClick={() => triggerSimulation('clear-logs')}
                className="text-[10px] font-mono text-zinc-500 hover:text-red-400 hover:border-red-950 border border-zinc-850 bg-zinc-900/60 px-2 py-0.5 rounded transition-all cursor-pointer"
              >
                Clear DB Environments
              </button>
            </h3>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-zinc-500 text-[10px] uppercase">
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Transaction ID (txHash)</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-zinc-600">
                        No replenishment logs recorded in MongoDB yet.
                      </td>
                    </tr>
                  ) : (
                    logs.map((log) => (
                      <tr 
                        key={log._id} 
                        className={`hover:bg-zinc-900/30 transition-colors ${
                          log.status === 'PROCESSING' ? 'bg-purple-950/10' : ''
                        }`}
                      >
                        <td className="py-3 px-3 text-zinc-400 whitespace-nowrap">
                          {formatTime(log.createdAt)}
                        </td>
                        <td className="py-3 px-3 max-w-[150px] truncate">
                          <a 
                            href={`https://nile.tronscan.org/#/transaction/${log.txHash}`} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-teal-400/80 hover:text-teal-400 hover:underline font-mono"
                            title={log.txHash}
                          >
                            {log.txHash.slice(0, 8)}...{log.txHash.slice(-8)}
                          </a>
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-zinc-200">
                          {(log.amount / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
                        </td>
                        <td className="py-3 px-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold inline-block border ${
                            log.status === 'SUCCESS' ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-400' :
                            log.status === 'PROCESSING' ? 'bg-purple-950/40 border-purple-500/30 text-purple-400 animate-pulse' :
                            log.status === 'PENDING' ? 'bg-amber-950/30 border-amber-500/30 text-amber-400' :
                            'bg-red-950/30 border-red-500/30 text-red-400'
                          }`} title={log.error}>
                            {log.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* DAEMON CLI CONSOLE (RIGHT SIDE) */}
          <div className="lg:col-span-5 bg-black border border-zinc-800 rounded-2xl p-4 shadow-xl flex flex-col h-[320px]">
            {/* Console Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-2.5 mb-3 font-mono">
              <div className="flex items-center gap-2">
                {/* Blinking green status node light */}
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                  daemons/depositListener.ts console
                </span>
              </div>
              <span className="text-[9px] text-zinc-600">STDOUT STREAMS</span>
            </div>

            {/* CLI LOG TERMINAL CELLS */}
            <div ref={terminalContainerRef} className="flex-1 overflow-y-auto font-mono text-[11px] leading-5 text-zinc-300 pr-1 flex flex-col gap-1.5 max-h-[250px] scrollbar-thin">
              {daemonLogs.length === 0 ? (
                <div className="text-zinc-700 italic select-none">
                  Waiting for daemon events logs... Make sure to run the daemon server!
                </div>
              ) : (
                daemonLogs.map((log, i) => (
                  <div key={log._id || i} className="flex gap-2 items-start break-all">
                    <span className="text-zinc-600 select-none">[{formatTime(log.createdAt)}]</span>
                    <span className={
                      log.type === 'success' ? 'text-emerald-400' :
                      log.type === 'warn' ? 'text-amber-400' :
                      log.type === 'error' ? 'text-red-400' :
                      'text-cyan-400'
                    }>
                      {log.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-zinc-900/60 mt-16 bg-[#04060b] py-8">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between text-zinc-600 text-xs font-mono gap-4">
          <p>© 2026 Aegis Wallet Safety. Enterprise Payment Gateway Infrastructure.</p>
          <div className="flex gap-4">
            <span className="text-zinc-500">Audit Logs (MongoDB)</span>
            <span>•</span>
            <span className="text-zinc-500">ECDSA Nile Gateway</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
