'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

// We do NOT redeclare window.ethereum here — ethers already provides
// the correct EIP-1193 type via its own ambient declarations.
// We use (window as any).ethereum to avoid the type conflict.

interface ReplenishmentLogBEP20 {
  _id: string;
  txHash: string;
  amount: string; // Wei string
  amountUSDT: number;
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

export default function BEP20Dashboard() {
  // App settings & metrics
  const [platformBalance, setPlatformBalance] = useState<number>(10240.50);
  const [lowFundsThreshold, setLowFundsThreshold] = useState<number>(15000.00);
  const [warmWalletAddress, setWarmWalletAddress] = useState<string>('');
  const [usdtContractAddress, setUsdtContractAddress] = useState<string>('');
  const [coldTreasuryAddress, setColdTreasuryAddress] = useState<string>('');
  const [warmWalletBalanceOnChain, setWarmWalletBalanceOnChain] = useState<number>(0);
  const [isLowFunds, setIsLowFunds] = useState<boolean>(true);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [activeLockTxHash, setActiveLockTxHash] = useState<string | null>(null);

  // Lists
  const [logs, setLogs] = useState<ReplenishmentLogBEP20[]>([]);
  const [daemonLogs, setDaemonLogs] = useState<DaemonLog[]>([]);

  // UI control states
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [amountInput, setAmountInput] = useState<string>('5000');
  const [sweepAmountInput, setSweepAmountInput] = useState<string>('2000');

  // Sweep states
  const [sweepStep, setSweepStep] = useState<'idle' | 'authenticating' | 'loading_key' | 'signing' | 'broadcasting' | 'confirmed' | 'error'>('idle');
  const [sweepStepMessage, setSweepStepMessage] = useState<string>('');
  const [sweepTxHash, setSweepTxHash] = useState<string>('');

  // Transaction lifecycle states
  const [step, setStep] = useState<'idle' | 'connecting' | 'preparing' | 'signing' | 'broadcasting' | 'db_lock' | 'daemon_check' | 'finished' | 'error'>('idle');
  const [stepMessage, setStepMessage] = useState<string>('');
  const [currentTxHash, setCurrentTxHash] = useState<string>('');

  // MetaMask state
  const [evmAddress, setEvmAddress] = useState<string>('');
  const [metamaskDetected, setMetamaskDetected] = useState<boolean>(false);
  const [metamaskConnected, setMetamaskConnected] = useState<boolean>(false);

  // Diagnostics state
  type DiagCheck = { ok: boolean; message: string; value?: string };
  const [diagResults, setDiagResults] = useState<Record<string, DiagCheck> | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagSummary, setDiagSummary] = useState<{ allPassed: boolean; failCount: number; totalChecks: number; status: string } | null>(null);

  const terminalContainerRef = useRef<HTMLDivElement>(null);

  // ─── Data Fetching ────────────────────────────────────────────────────────
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/bep20/status');
      const json = await res.json();
      if (json.success) {
        setPlatformBalance(json.data.platformBalance);
        setLowFundsThreshold(json.data.lowFundsThreshold);
        setWarmWalletAddress(json.data.warmWalletAddress);
        setUsdtContractAddress(json.data.usdtContractAddress);
        setColdTreasuryAddress(json.data.coldTreasuryAddress || '');
        setWarmWalletBalanceOnChain(json.data.warmWalletBalanceOnChain);
        setIsLowFunds(json.data.isLowFunds);
        setIsLocked(json.data.isLocked);
        setActiveLockTxHash(json.data.activeLockTxHash);
        setLogs(json.data.logs);
      }
    } catch (err) {
      console.error('[BSC] Error fetching status data:', err);
    }
  };

  const fetchDaemonLogs = async () => {
    try {
      const res = await fetch('/api/bep20/simulate-daemon');
      const json = await res.json();
      if (json.success) {
        setDaemonLogs(json.logs);
      }
    } catch (err) {
      console.error('[BSC] Error fetching daemon logs:', err);
    }
  };

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

  // ─── MetaMask Detection ───────────────────────────────────────────────────
  useEffect(() => {
    const checkMetaMask = async () => {
      const eth = (window as any).ethereum;
      if (typeof window !== 'undefined' && eth) {
        setMetamaskDetected(true);
        try {
          const accounts: string[] = await eth.request({ method: 'eth_accounts' });
          if (accounts && accounts.length > 0) {
            setEvmAddress(accounts[0]);
            setMetamaskConnected(true);
          }
        } catch {
          // accounts not yet granted, just mark as detected
        }
      } else {
        setMetamaskDetected(false);
      }
    };

    checkMetaMask();
    const detectInterval = setInterval(checkMetaMask, 1000);
    return () => clearInterval(detectInterval);
  }, []);

  // Auto-scroll daemon terminal
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [daemonLogs]);

  // ─── Connect MetaMask ─────────────────────────────────────────────────────
  const connectMetaMask = async (): Promise<string> => {
    const eth = (window as any).ethereum;
    if (typeof window === 'undefined' || !eth) {
      throw new Error('MetaMask extension not found. Please install MetaMask to proceed.');
    }

    try {
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts returned from MetaMask.');
      }

      // Switch to BSC Mainnet (chainId 56 = 0x38)
      try {
        await eth.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x38' }], // BSC Mainnet
        });
      } catch (switchErr: any) {
        // If BSC Mainnet isn't added, add it
        if (switchErr.code === 4902) {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x38',
              chainName: 'BNB Smart Chain Mainnet',
              nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
              rpcUrls: ['https://bsc-dataseed.binance.org/'],
              blockExplorerUrls: ['https://bscscan.com'],
            }],
          });
        }
      }

      const addr = accounts[0];
      setEvmAddress(addr);
      setMetamaskConnected(true);
      return addr;
    } catch (err: any) {
      throw new Error(err.message || 'MetaMask connection rejected.');
    }
  };

  // ─── Simulation Trigger ───────────────────────────────────────────────────
  const triggerSimulation = async (action: string, txHash?: string) => {
    try {
      const res = await fetch('/api/bep20/simulate-daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, txHash }),
      });
      const data = await res.json();
      fetchStatus();
      fetchDaemonLogs();
      return data;
    } catch (err) {
      console.error('[BSC] Simulation command failed:', err);
    }
  };

  // ─── Reset Handlers ───────────────────────────────────────────────────────
  const handleResetWorkflow = () => {
    setStep('idle');
    setStepMessage('');
    setCurrentTxHash('');
  };

  const handleResetSweep = () => {
    setSweepStep('idle');
    setSweepStepMessage('');
    setSweepTxHash('');
  };

  // ─── Replenishment Initiator ──────────────────────────────────────────────
  const handleInitiateReplenishment = async () => {
    if (isLocked) {
      alert('SYSTEM LOCKED: A BSC replenishment is already in progress. Mutex lock is active.');
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

  // ─── Mock Workflow ────────────────────────────────────────────────────────
  const runMockWorkflow = async (amount: number) => {
    setStep('connecting');
    setStepMessage('Simulating MetaMask wallet connection on BSC Testnet...');

    setTimeout(() => {
      setStep('preparing');
      setStepMessage('Encoding BEP-20 transfer(address,uint256) calldata for USDT contract...');

      setTimeout(() => {
        setStep('signing');
        setStepMessage('Requesting MetaMask signature for BEP-20 transfer payload...');

        setTimeout(() => {
          setStep('broadcasting');
          setStepMessage('Broadcasting signed BEP-20 transfer to BSC Testnet nodes...');

          const hexChars = '0123456789abcdef';
          let mockHash = '0x';
          for (let i = 0; i < 64; i++) {
            mockHash += hexChars[Math.floor(Math.random() * 16)];
          }

          setTimeout(async () => {
            setCurrentTxHash(mockHash);
            setStep('db_lock');
            setStepMessage('Transaction broadcasted. Submitting txHash to backend to acquire Mutex lock...');

            try {
              const res = await fetch('/api/bep20/replenish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  txHash: mockHash,
                  amount: amountInput,
                  fromAddress: '0xMockColdTreasury',
                }),
              });
              const json = await res.json();

              if (!json.success) {
                setStep('error');
                setStepMessage(`Backend API Rejected: ${json.error}`);
                return;
              }

              setStep('daemon_check');
              setStepMessage('Mutex lock acquired [PROCESSING]. BSC daemon watching for Transfer event confirmation...');

              setTimeout(async () => {
                await triggerSimulation('confirm', mockHash);
                setStep('finished');
                setStepMessage(`BEP-20 replenishment settled! Platform balance updated by +${amountInput} USDT.`);
              }, 3500);
            } catch (error: any) {
              setStep('error');
              setStepMessage(`HTTP Connection Failed: ${error.message}`);
            }
          }, 1500);
        }, 1800);
      }, 1200);
    }, 1000);
  };

  // ─── Live Workflow ────────────────────────────────────────────────────────
  const runLiveWorkflow = async (amount: number) => {
    setStep('connecting');
    setStepMessage('Requesting MetaMask wallet connection on BSC Testnet...');

    try {
      const activeAddress = await connectMetaMask();

      setStep('preparing');
      setStepMessage(`Connected: ${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}. Preparing BEP-20 transfer...`);

      // Use ethers BrowserProvider (MetaMask injected)
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();

      const ERC20_ABI_MIN = [
        'function transfer(address to, uint256 amount) returns (bool)',
      ];

      const contract = new ethers.Contract(usdtContractAddress, ERC20_ABI_MIN, signer);
      const amountWei = ethers.parseUnits(amount.toString(), 18);

      setStep('signing');
      setStepMessage('Waiting for MetaMask signature confirmation...');

      const tx = await contract.transfer(warmWalletAddress, amountWei);

      setStep('broadcasting');
      setStepMessage('Transaction signed. Waiting for BSC network confirmation...');

      const receipt = await tx.wait(1);
      const realTxHash: string = receipt.hash;
      setCurrentTxHash(realTxHash);

      setStep('db_lock');
      setStepMessage('Transaction confirmed on-chain. Submitting txHash to backend to acquire Mutex lock...');

      const res = await fetch('/api/bep20/replenish', {
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
      setStepMessage('Mutex lock acquired [PROCESSING]. BSC daemon (daemons/bscDepositListener.ts) watching for event confirmation...');
    } catch (err: any) {
      console.error('[BSC]', err);
      setStep('error');
      setStepMessage(`Live BSC Transaction Failed: ${err.message || err}`);
    }
  };

  // ─── Sweep Workflows ──────────────────────────────────────────────────────
  const handleInitiateSweep = async () => {
    const amt = parseFloat(sweepAmountInput);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid positive sweep amount.');
      return;
    }
    if (amt > platformBalance) {
      alert(`Insufficient BSC platform balance. You can only sweep up to $${platformBalance.toLocaleString()} USDT.`);
      return;
    }
    setSweepTxHash('');
    if (mode === 'live') {
      await runLiveSweep(amt);
    } else {
      await runMockSweep(amt);
    }
  };

  const runMockSweep = async (amount: number) => {
    setSweepStep('authenticating');
    setSweepStepMessage('Authenticating administrative credentials...');
    setTimeout(() => {
      setSweepStep('loading_key');
      setSweepStepMessage('Loading BSC Warm Wallet key from secure enclave (Turnkey KMS)...');
      setTimeout(() => {
        setSweepStep('signing');
        setSweepStepMessage('Signing BEP-20 transfer payload with secp256k1 ECDSA core...');
        setTimeout(() => {
          setSweepStep('broadcasting');
          setSweepStepMessage('Broadcasting signed EIP-155 transaction to BSC Testnet nodes...');
          setTimeout(async () => {
            try {
              const res = await fetch('/api/bep20/sweep', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, isMock: true }),
              });
              const json = await res.json();
              if (json.success) {
                setSweepTxHash(json.data.txHash);
                setSweepStep('confirmed');
                setSweepStepMessage(`Sweep confirmed! ${amount} USDT moved to Cold Treasury on BSC.`);
                fetchStatus();
                fetchDaemonLogs();
              } else {
                setSweepStep('error');
                setSweepStepMessage(json.error || 'Failed to complete BSC sweep execution.');
              }
            } catch (err: any) {
              setSweepStep('error');
              setSweepStepMessage(err.message || 'Network error encountered.');
            }
          }, 1200);
        }, 1200);
      }, 1000);
    }, 800);
  };

  const runLiveSweep = async (amount: number) => {
    setSweepStep('authenticating');
    setSweepStepMessage('Authenticating Turnkey API credentials...');
    setTimeout(async () => {
      setSweepStep('loading_key');
      setSweepStepMessage('Verifying BSC Warm Wallet Turnkey configuration...');
      setTimeout(async () => {
        setSweepStep('signing');
        setSweepStepMessage('Constructing ERC-20 calldata & requesting Turnkey secp256k1 signature...');
        setTimeout(async () => {
          setSweepStep('broadcasting');
          setSweepStepMessage('Broadcasting EIP-155 signed transaction to BSC Testnet RPC...');
          try {
            const res = await fetch('/api/bep20/sweep', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ amount, isMock: false }),
            });
            const json = await res.json();
            if (json.success) {
              setSweepTxHash(json.data.txHash);
              setSweepStep('confirmed');
              setSweepStepMessage(`BSC Sweep Confirmed! txHash: ${json.data.txHash.slice(0, 14)}...`);
              fetchStatus();
              fetchDaemonLogs();
            } else {
              setSweepStep('error');
              setSweepStepMessage(json.error || 'Failed to complete live BSC sweep.');
            }
          } catch (err: any) {
            setSweepStep('error');
            setSweepStepMessage(err.message || 'Live BSC network request failed.');
          }
        }, 1000);
      }, 1000);
    }, 800);
  };

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans selection:bg-amber-500 selection:text-black antialiased">
      {/* GLOW DECORATIONS — BSC amber/orange palette */}
      <div className="absolute top-0 left-1/4 w-[40vw] h-[40vh] bg-amber-500/8 rounded-full blur-[130px] pointer-events-none" />
      <div className="absolute top-[20%] right-1/4 w-[35vw] h-[35vh] bg-orange-500/5 rounded-full blur-[110px] pointer-events-none" />

      {/* HEADER NAVBAR */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/60 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* BNB Logo */}
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 p-[1px] shadow-lg shadow-amber-500/20">
              <div className="w-full h-full bg-[#0a0f1d] rounded-xl flex items-center justify-center">
                <span className="text-amber-400 font-black text-lg">◆</span>
              </div>
            </div>
            <div>
              <h1 className="text-md font-bold tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-yellow-300 uppercase">
                Aegis Gateway
              </h1>
              <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">BEP-20 / BSC Module</p>
            </div>
          </div>

          <div className="flex items-center gap-4 font-mono text-xs">
            {/* Network Tab Switcher */}
            <div className="hidden sm:flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              <Link
                href="/"
                className="px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-all text-[11px]"
              >
                TRON / TRC-20
              </Link>
              <span className="px-3 py-1.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] font-semibold">
                BSC / BEP-20
              </span>
            </div>

            {/* BSC Testnet Badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <span className="text-zinc-400">BSC Testnet</span>
            </div>

            {/* MetaMask Connection Badge */}
            {metamaskConnected ? (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-950/40 border border-amber-800/60 text-amber-400">
                <span>MM Connected:</span>
                <span className="font-semibold">{evmAddress.slice(0, 5)}...{evmAddress.slice(-4)}</span>
              </div>
            ) : (
              <button
                onClick={connectMetaMask}
                className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 transition-colors text-zinc-400 cursor-pointer"
              >
                <span>MM Disconnected</span>
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-7xl mx-auto px-6 py-8 flex flex-col gap-6">

        {/* STATUS ALERT BANNER */}
        <div className={`p-4 rounded-2xl border backdrop-blur-md transition-all duration-500 shadow-xl flex items-center justify-between flex-wrap gap-4 ${
          isLowFunds
            ? 'bg-red-950/20 border-red-500/30 text-red-300 shadow-red-950/10'
            : 'bg-amber-950/20 border-amber-500/30 text-amber-300 shadow-amber-950/10'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
              isLowFunds ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
            }`}>
              {isLowFunds ? '!' : '◆'}
            </div>
            <div>
              <p className="font-bold text-sm uppercase tracking-wider">
                {isLowFunds ? 'Critical Alert: BSC Liquidity Low' : 'BSC System Secure: Liquidity Nominal'}
              </p>
              <p className={`text-xs ${isLowFunds ? 'text-red-400/80' : 'text-amber-400/80'}`}>
                {isLowFunds
                  ? `BSC platform is at $${platformBalance.toLocaleString()} USDT, below safety limit of $${lowFundsThreshold.toLocaleString()} USDT.`
                  : `BSC platform healthy at $${platformBalance.toLocaleString()} USDT (Threshold: $${lowFundsThreshold.toLocaleString()} USDT).`
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
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-amber-800/50 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-amber-500 to-orange-500 opacity-70" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">BSC Platform Balance</p>
            <h2 className="text-3xl font-black mt-2 font-mono text-zinc-50 group-hover:text-amber-400 transition-colors">
              ${platformBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h2>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono">Internal database ledger (USDT)</p>
          </div>

          {/* Card 2: Warm Wallet On-Chain */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-yellow-800/50 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-yellow-500 to-amber-500 opacity-70" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Warm Wallet On-Chain (BSC)</p>
            <h2 className="text-3xl font-black mt-2 font-mono text-zinc-50 group-hover:text-yellow-400 transition-colors">
              {warmWalletBalanceOnChain.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-zinc-400">USDT</span>
            </h2>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono truncate">BSC Addr: {warmWalletAddress}</p>
          </div>

          {/* Card 3: Cold Treasury */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden group hover:border-orange-800/50 transition-all duration-300">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-red-500 opacity-60" />
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">Cold Treasury Bridge</p>
            <div className="flex items-center gap-2 mt-3">
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
              <h3 className="text-lg font-bold text-zinc-200">Hardware Locked</h3>
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono">Turnkey KMS secp256k1 Enclave</p>
          </div>

          {/* Card 4: Mutex Queue Lock */}
          <div className={`border rounded-2xl p-6 shadow-lg backdrop-blur-md relative overflow-hidden transition-all duration-500 ${
            isLocked
              ? 'bg-red-950/15 border-red-500/40 shadow-red-950/5'
              : 'bg-zinc-900/40 border-zinc-800/80 hover:border-amber-800/40'
          }`}>
            {isLocked && <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />}
            {!isLocked && <div className="absolute top-0 left-0 w-1 h-full bg-zinc-700" />}
            <p className="text-zinc-400 font-mono text-[10px] uppercase tracking-wider">BSC Queue Mutex Lock</p>
            <div className="flex items-center gap-2.5 mt-3">
              <div className={`w-3 h-3 rounded-full ${isLocked ? 'bg-red-500 animate-ping' : 'bg-amber-500'}`} />
              <span className={`text-md font-bold tracking-wide ${isLocked ? 'text-red-400 font-mono text-xs uppercase' : 'text-amber-400'}`}>
                {isLocked ? 'MUTEX ACQUIRED (LOCKED)' : 'IDLE - READY FOR FILL'}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 font-mono truncate">
              {isLocked ? `Locked by tx: ${activeLockTxHash?.slice(0, 14)}...` : 'No concurrent deposits active'}
            </p>
          </div>
        </section>

        {/* REPLENISHMENT & SWEEP SECTION */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* LEFT CONTROLS */}
          <div className="lg:col-span-7 flex flex-col gap-6">

            {/* REPLENISHMENT CONSOLE */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md">
              <h3 className="text-lg font-extrabold tracking-wide mb-4 flex items-center justify-between border-b border-zinc-900 pb-3">
                <span>BEP-20 REPLENISHMENT CONSOLE</span>
                {/* MODE TOGGLER */}
                <div className="flex bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-xs font-mono">
                  <button
                    onClick={() => { if (step === 'idle') setMode('mock'); }}
                    disabled={step !== 'idle'}
                    className={`px-3 py-1 rounded-md transition-all cursor-pointer ${
                      mode === 'mock'
                        ? 'bg-amber-500 text-black font-semibold'
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
                        ? 'bg-amber-500 text-black font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200 disabled:opacity-40'
                    }`}
                  >
                    LIVE BSC
                  </button>
                </div>
              </h3>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Destination Address (BSC Warm Wallet)</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-300">
                    <span className="flex-1 select-all">{warmWalletAddress || 'Loading...'}</span>
                    <span className="text-amber-400 text-xs uppercase font-bold">Hardcoded Server Destination</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">BEP-20 USDT Contract Address</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-400">
                    <span className="flex-1 select-all">{usdtContractAddress || 'Loading...'}</span>
                    <span className="text-yellow-400 text-xs">BEP-20 Token</span>
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
                        className="w-full bg-[#0b0f19] border border-zinc-800 focus:border-amber-500 focus:ring-1 focus:ring-amber-500/20 rounded-xl pl-4 pr-16 py-3 font-mono text-zinc-100 placeholder-zinc-700 outline-none transition-colors"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-xs">USDT</span>
                    </div>
                  </div>

                  <button
                    onClick={handleInitiateReplenishment}
                    disabled={step !== 'idle' || isLocked || !warmWalletAddress || !usdtContractAddress}
                    className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black font-extrabold tracking-wide uppercase transition-all duration-300 shadow-lg shadow-amber-500/15 hover:shadow-amber-400/25 disabled:from-zinc-900 disabled:to-zinc-900 disabled:border-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2 h-[46px] cursor-pointer"
                  >
                    Initiate Replenishment
                  </button>
                </div>
              </div>

              {/* Architecture Info */}
              <div className="mt-6 border-t border-zinc-900 pt-5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-3">BSC Multi-Tier Safety Workflow</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[9px] text-zinc-400">
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-amber-400">Tier 1: MetaMask</span>
                    <span>EVM Browser Wallet</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-yellow-400">Tier 2: Broadcast</span>
                    <span>BSC Testnet RPC</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-orange-400">Tier 3: Database</span>
                    <span>Mutex status lock</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-red-400">Tier 4: Daemon</span>
                    <span>Transfer event watcher</span>
                  </div>
                </div>
              </div>
            </div>

            {/* SWEEP PORTAL */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md">
              <h3 className="text-lg font-extrabold tracking-wide mb-4 flex items-center justify-between border-b border-zinc-900 pb-3">
                <span>BSC SWEEP PORTAL / WITHDRAWAL CONSOLE</span>
                <span className="text-[10px] font-mono bg-amber-950/50 border border-amber-800/60 text-amber-400 px-2 py-0.5 rounded animate-pulse">
                  Warm-to-Cold
                </span>
              </h3>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Source Address (BSC Warm Wallet)</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-400">
                    <span className="flex-1 select-all">{warmWalletAddress || 'Loading...'}</span>
                    <span className="text-orange-400 text-xs">Origin</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Destination Address (BSC Cold Treasury)</label>
                  <div className="flex bg-[#0b0f19] border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-300">
                    <span className="flex-1 select-all">{coldTreasuryAddress || 'Loading...'}</span>
                    <span className="text-amber-400 text-xs uppercase font-bold">Hardcoded Destination</span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-end mt-1">
                  <div className="flex-1 flex flex-col gap-1.5 w-full">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">USDT Sweep Amount</label>
                    <div className="relative">
                      <input
                        type="number"
                        disabled={sweepStep !== 'idle'}
                        value={sweepAmountInput}
                        onChange={(e) => setSweepAmountInput(e.target.value)}
                        placeholder="2,000"
                        className="w-full bg-[#0b0f19] border border-zinc-800 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20 rounded-xl pl-4 pr-16 py-3 font-mono text-zinc-100 placeholder-zinc-700 outline-none transition-colors"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-xs">USDT</span>
                    </div>
                  </div>
                  <button
                    onClick={handleInitiateSweep}
                    disabled={sweepStep !== 'idle' || !coldTreasuryAddress || !warmWalletAddress}
                    className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-400 hover:to-red-400 text-white font-extrabold tracking-wide uppercase transition-all duration-300 shadow-lg shadow-orange-500/10 hover:shadow-orange-400/20 disabled:from-zinc-900 disabled:to-zinc-900 disabled:border-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2 h-[46px] cursor-pointer"
                  >
                    Initiate Sweep to Cold
                  </button>
                </div>
              </div>

              <div className="mt-6 border-t border-zinc-900 pt-5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-3">BSC Sweep Security Policies</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[9px] text-zinc-400">
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-amber-400">Turnkey secp256k1</span>
                    <span>BSC key never leaves KMS</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-orange-400">Fixed Destination</span>
                    <span>Cold address hardcoded in .env</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 flex flex-col gap-0.5">
                    <span className="text-yellow-400">EIP-155 Signing</span>
                    <span>Replay protection enforced</span>
                  </div>
                </div>
              </div>
            </div>

            {/* SWEEP PROGRESS PANEL */}
            {sweepStep !== 'idle' && (
              <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-900 pb-3">
                  <h3 className="text-sm font-bold text-zinc-300 uppercase tracking-widest font-mono">BSC Sweep Execution Flow</h3>
                  <button onClick={handleResetSweep} className="px-2.5 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-md bg-zinc-900 cursor-pointer">
                    Reset Console
                  </button>
                </div>
                <div className="flex flex-col gap-4 text-xs font-mono">
                  <div className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800 p-3.5 rounded-xl">
                    <div className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] text-zinc-500 uppercase">Stage: {sweepStep.replace('_', ' ')}</p>
                      <p className="text-zinc-200 mt-0.5">{sweepStepMessage}</p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3.5 mt-2">
                    {[
                      { label: 'Administrative Authentication', stages: [] as string[] },
                      { label: 'Turnkey KMS Key Initialization', stages: ['authenticating'] },
                      { label: 'secp256k1 ECDSA EIP-155 Signing', stages: ['authenticating', 'loading_key'] },
                      { label: 'Broadcast to BSC Testnet Gateway', stages: ['authenticating', 'loading_key', 'signing'] },
                      { label: 'Sweep Settled & Balance Sheet Updated', stages: ['authenticating', 'loading_key', 'signing', 'broadcasting'] },
                    ].map((item, idx) => {
                      const isComplete = !item.stages.includes(sweepStep) && sweepStep !== 'error';
                      const _isActive = (['authenticating', 'loading_key', 'signing', 'broadcasting', 'confirmed'] as const)[idx] === sweepStep;
                      return (
                        <div key={idx} className="flex items-center gap-3">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            sweepStep === 'confirmed' && idx === 4 ? 'bg-amber-500 text-black' :
                            isComplete ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-500'
                          }`}>{idx + 1}</div>
                          <span className={isComplete || (sweepStep === 'confirmed' && idx === 4) ? 'text-zinc-300' : 'text-zinc-500'}>{item.label}</span>
                        </div>
                      );
                    })}
                  </div>

                  {sweepTxHash && (
                    <div className="mt-4 pt-4 border-t border-zinc-900 text-[10px]">
                      <span className="text-zinc-500">SWEEP TX HASH:</span>{' '}
                      <a
                        href={`https://testnet.bscscan.com/tx/${sweepTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400 hover:underline break-all font-mono"
                      >
                        {sweepTxHash}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* REPLENISHMENT PROGRESS PANEL */}
            {step !== 'idle' && (
              <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-900 pb-3">
                  <h3 className="text-sm font-bold text-zinc-300 uppercase tracking-widest font-mono">BSC Replenishment Execution Flow</h3>
                  <button onClick={handleResetWorkflow} className="px-2.5 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-md bg-zinc-900 cursor-pointer">
                    Reset Console
                  </button>
                </div>

                <div className="flex flex-col gap-4 text-xs font-mono">
                  <div className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800 p-3.5 rounded-xl">
                    <div className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] text-zinc-500 uppercase">Stage: {step.replace('_', ' ')}</p>
                      <p className="text-zinc-200 mt-0.5">{stepMessage}</p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3.5 mt-2">
                    {[
                      { label: 'Connect MetaMask (BSC Testnet)', active: 'connecting' },
                      { label: 'Encode BEP-20 Transfer Calldata', active: 'preparing' },
                      { label: 'MetaMask Signature Authorization', active: 'signing' },
                      { label: 'Broadcast to BSC Testnet RPC', active: 'broadcasting' },
                      { label: 'Backend Mutex Acquisition ([PROCESSING])', active: 'db_lock' },
                      { label: 'BSC Daemon Transfer Event Verification', active: 'daemon_check' },
                    ].map((item, idx) => {
                      const steps = ['connecting', 'preparing', 'signing', 'broadcasting', 'db_lock', 'daemon_check', 'finished'];
                      const currentIdx = steps.indexOf(step);
                      const itemIdx = idx;
                      const isDone = step === 'finished' || currentIdx > itemIdx;
                      return (
                        <div key={idx} className="flex items-center gap-3">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            isDone ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-500'
                          }`}>{idx + 1}</div>
                          <div className="flex-1 flex justify-between items-center">
                            <span className={isDone ? 'text-zinc-300' : 'text-zinc-500'}>{item.label}</span>
                            {step === 'daemon_check' && idx === 5 && (
                              <button
                                onClick={() => triggerSimulation('confirm', currentTxHash)}
                                className="bg-amber-600 hover:bg-amber-500 text-black px-2 py-0.5 text-[9px] rounded cursor-pointer font-bold"
                              >
                                Force Verify Now
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {currentTxHash && (
                    <div className="mt-4 pt-4 border-t border-zinc-900 text-[10px]">
                      <span className="text-zinc-500">CAPTURED TX HASH:</span>{' '}
                      <a
                        href={`https://testnet.bscscan.com/tx/${currentTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400 hover:underline break-all font-mono"
                      >
                        {currentTxHash}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── DIAGNOSTICS PANEL ── */}
          <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md">
            <div className="flex items-center justify-between mb-4 border-b border-zinc-900 pb-3">
              <div>
                <h3 className="text-sm font-bold text-zinc-200 uppercase tracking-widest font-mono">System Diagnostics</h3>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Validates Turnkey KMS, BSC RPC & env configuration</p>
              </div>
              <button
                onClick={async () => {
                  setDiagLoading(true);
                  setDiagResults(null);
                  setDiagSummary(null);
                  try {
                    const res = await fetch('/api/bep20/diagnostics');
                    const json = await res.json();
                    setDiagResults(json.checks);
                    setDiagSummary(json.summary);
                  } catch (e: any) {
                    setDiagResults({ 'fetch.error': { ok: false, message: e.message } });
                  } finally {
                    setDiagLoading(false);
                  }
                }}
                disabled={diagLoading}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black font-bold text-xs uppercase tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {diagLoading ? 'Running...' : 'Run Diagnostics'}
              </button>
            </div>

            {/* Summary badge */}
            {diagSummary && (
              <div className={`mb-4 px-4 py-3 rounded-xl border font-mono text-xs flex items-center gap-3 ${
                diagSummary.allPassed
                  ? 'bg-emerald-950/30 border-emerald-700/50 text-emerald-400'
                  : 'bg-red-950/30 border-red-700/50 text-red-400'
              }`}>
                <span className="text-lg">{diagSummary.allPassed ? '✅' : '❌'}</span>
                <div>
                  <p className="font-bold">{diagSummary.status.replace(/_/g, ' ')}</p>
                  <p className="text-[10px] opacity-70">{diagSummary.totalChecks} checks · {diagSummary.failCount} failed</p>
                </div>
              </div>
            )}

            {/* Check results */}
            {diagResults && (
              <div className="flex flex-col gap-2 font-mono text-[11px]">
                {Object.entries(diagResults).map(([key, check]) => (
                  <div
                    key={key}
                    className={`flex items-start gap-3 p-3 rounded-lg border ${
                      check.ok
                        ? 'bg-emerald-950/20 border-emerald-900/50'
                        : 'bg-red-950/20 border-red-900/50'
                    }`}
                  >
                    <span className="mt-0.5 shrink-0">{check.ok ? '✅' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-zinc-400 text-[10px] uppercase tracking-wider">{key}</p>
                      <p className={`mt-0.5 break-words ${check.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                        {check.message}
                      </p>
                      {check.value && (
                        <p className="text-zinc-500 text-[10px] mt-1 truncate" title={check.value}>
                          {check.value}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!diagResults && !diagLoading && (
              <p className="text-zinc-600 font-mono text-xs text-center py-6">
                Click &quot;Run Diagnostics&quot; to verify your full BSC + Turnkey setup.
              </p>
            )}

            {diagLoading && (
              <div className="flex items-center justify-center gap-3 py-8 text-zinc-400 font-mono text-xs">
                <span className="animate-spin text-amber-400 text-lg">⟳</span>
                Contacting Turnkey API and BSC RPC...
              </div>
            )}
          </div>

          {/* RIGHT: BSC INFO PANEL */}
          <div className="lg:col-span-5 flex flex-col gap-6">

            {/* BNB Chain Architecture Card */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md flex flex-col gap-5">
              <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                BNB Smart Chain (BSC) Architecture
              </p>

              {/* BSC Chain Visual */}
              <div className="relative w-full bg-[#1a1800] rounded-3xl p-6 shadow-2xl border border-amber-900/40 flex flex-col gap-4">

                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-500/30">
                      <span className="text-black font-black text-sm">◆</span>
                    </div>
                    <div>
                      <p className="text-amber-400 font-bold text-xs">BNB Smart Chain</p>
                      <p className="text-zinc-500 text-[10px]">Chain ID: 56 (Mainnet)</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                    </span>
                    <span className="text-amber-400 text-[10px] font-mono">LIVE</span>
                  </div>
                </div>

                {/* Token Flow */}
                <div className="flex flex-col gap-3 font-mono text-[11px]">
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 flex flex-col gap-1">
                    <span className="text-zinc-500 text-[9px] uppercase">Cold Treasury (Source)</span>
                    <span className="text-zinc-200 truncate">{coldTreasuryAddress || '0x... (loading)'}</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="bg-orange-950/50 border border-orange-800/40 text-orange-400 text-[9px] px-1.5 py-0.5 rounded">Ledger / Hardware</span>
                    </div>
                  </div>

                  {/* Arrow */}
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent to-amber-500/50" />
                    <div className="text-amber-500 text-xs font-bold">BEP-20 USDT ↓</div>
                    <div className="h-px flex-1 bg-gradient-to-l from-transparent to-amber-500/50" />
                  </div>

                  <div className="bg-zinc-900/60 border border-amber-800/40 rounded-xl p-3 flex flex-col gap-1">
                    <span className="text-amber-500/80 text-[9px] uppercase">Warm Wallet (Destination)</span>
                    <span className="text-zinc-200 truncate">{warmWalletAddress || '0x... (loading)'}</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="bg-amber-950/50 border border-amber-800/40 text-amber-400 text-[9px] px-1.5 py-0.5 rounded">Turnkey KMS</span>
                      <span className="bg-zinc-900 border border-zinc-800 text-zinc-400 text-[9px] px-1.5 py-0.5 rounded">secp256k1</span>
                    </div>
                  </div>
                </div>

                {/* Network Info */}
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div className="bg-zinc-900/40 rounded-lg p-2 border border-zinc-800">
                    <p className="text-zinc-500">Block Time</p>
                    <p className="text-zinc-200 font-bold">~3 seconds</p>
                  </div>
                  <div className="bg-zinc-900/40 rounded-lg p-2 border border-zinc-800">
                    <p className="text-zinc-500">Token Standard</p>
                    <p className="text-amber-400 font-bold">BEP-20 (EVM)</p>
                  </div>
                  <div className="bg-zinc-900/40 rounded-lg p-2 border border-zinc-800">
                    <p className="text-zinc-500">Decimals</p>
                    <p className="text-zinc-200 font-bold">18 (Wei)</p>
                  </div>
                  <div className="bg-zinc-900/40 rounded-lg p-2 border border-zinc-800">
                    <p className="text-zinc-500">Explorer</p>
                    <a
                      href="https://testnet.bscscan.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-400 font-bold hover:underline"
                    >
                      BSCScan ↗
                    </a>
                  </div>
                </div>
              </div>

              {/* MetaMask status */}
              <div className="text-center text-xs text-zinc-500 font-mono">
                {!metamaskDetected && (
                  <p className="text-red-400 animate-pulse">MetaMask not detected. Install the MetaMask browser extension to use Live mode.</p>
                )}
                {metamaskDetected && !metamaskConnected && (
                  <p className="text-amber-400 animate-pulse">MetaMask detected but not connected. Click "MM Disconnected" in the header to connect.</p>
                )}
                {metamaskConnected && (
                  <p className="text-amber-400">MetaMask connected: {evmAddress.slice(0, 8)}...{evmAddress.slice(-6)}</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* DAEMON TERMINAL & LOGS */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* AUDIT LOGS TABLE */}
          <div className="lg:col-span-7 bg-zinc-950/40 border border-zinc-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-md flex flex-col">
            <h3 className="text-sm font-bold tracking-widest text-zinc-300 uppercase mb-4 border-b border-zinc-900 pb-3 flex justify-between items-center font-mono">
              <span>BEP-20 Replenishment Audits & Mutex Logs</span>
              <button
                onClick={() => triggerSimulation('clear-logs')}
                className="text-[10px] font-mono text-zinc-500 hover:text-red-400 hover:border-red-950 border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 rounded transition-all cursor-pointer"
              >
                Clear DB Environments
              </button>
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-zinc-500 text-[10px] uppercase">
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">BSC Transaction Hash</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-zinc-600">
                        No BSC replenishment logs recorded yet.
                      </td>
                    </tr>
                  ) : (
                    logs.map((log) => (
                      <tr
                        key={log._id}
                        className={`hover:bg-zinc-900/30 transition-colors ${log.status === 'PROCESSING' ? 'bg-amber-950/10' : ''}`}
                      >
                        <td className="py-3 px-3 text-zinc-400 whitespace-nowrap">
                          {formatTime(log.createdAt)}
                        </td>
                        <td className="py-3 px-3 max-w-[150px] truncate">
                          <a
                            href={`https://testnet.bscscan.com/tx/${log.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-amber-400/80 hover:text-amber-400 hover:underline font-mono"
                            title={log.txHash}
                          >
                            {log.txHash.slice(0, 10)}...{log.txHash.slice(-8)}
                          </a>
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-zinc-200">
                          {log.amountUSDT?.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
                        </td>
                        <td className="py-3 px-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold inline-block border ${
                            log.status === 'SUCCESS' ? 'bg-amber-950/30 border-amber-500/30 text-amber-400' :
                            log.status === 'PROCESSING' ? 'bg-orange-950/40 border-orange-500/30 text-orange-400 animate-pulse' :
                            log.status === 'PENDING' ? 'bg-yellow-950/30 border-yellow-500/30 text-yellow-400' :
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

          {/* DAEMON CLI CONSOLE */}
          <div className="lg:col-span-5 bg-black border border-zinc-800 rounded-2xl p-4 shadow-xl flex flex-col h-[320px]">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-2.5 mb-3 font-mono">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                  daemons/bscDepositListener.ts console
                </span>
              </div>
              <span className="text-[9px] text-zinc-600">STDOUT STREAMS</span>
            </div>

            <div
              ref={terminalContainerRef}
              className="flex-1 overflow-y-auto font-mono text-[11px] leading-5 text-zinc-300 pr-1 flex flex-col gap-1.5 max-h-[250px]"
            >
              {daemonLogs.length === 0 ? (
                <div className="text-zinc-700 italic select-none">
                  Waiting for BSC daemon events... Run `npm run daemon:bsc` to start!
                </div>
              ) : (
                daemonLogs.map((log, i) => (
                  <div key={log._id || i} className="flex gap-2 items-start break-all">
                    <span className="text-zinc-600 select-none">[{formatTime(log.createdAt)}]</span>
                    <span className={
                      log.type === 'success' ? 'text-amber-400' :
                      log.type === 'warn' ? 'text-yellow-400' :
                      log.type === 'error' ? 'text-red-400' :
                      'text-orange-300'
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
          <p>© 2026 Aegis Wallet Safety — BEP-20 BSC Module. Enterprise Payment Gateway.</p>
          <div className="flex gap-4">
            <span className="text-zinc-500">Audit Logs (MongoDB)</span>
            <span>•</span>
            <a href="https://testnet.bscscan.com" target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-amber-400 transition-colors">BSCScan Testnet ↗</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
