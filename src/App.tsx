/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef, FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Volume2, Play, RotateCcw, CheckCircle2, XCircle, Timer, User, 
  MapPin, Activity, ChevronRight, Settings, X, Sliders, HelpCircle,
  Trophy, Award, Crown, Loader2, ArrowRight, Maximize, Minimize,
  Users, Lock, Unlock, Copy, Check, LogOut, Compass, ShieldAlert,
  PlusCircle, Search, Zap, RotateCw, Share2, Clock, Sparkles
} from 'lucide-react';
import { VOICE_DB, CHARACTERS, BASE_VOICE_URL, CharKey, VoiceData } from './constants';
import { 
  submitScore, getLeaderboard, LeaderboardEntry, db, auth, isDummy, 
  loginAnonymously, OperationType, handleFirestoreError 
} from './firebase';
import { 
  collection, doc, setDoc, updateDoc, onSnapshot, getDoc, 
  runTransaction, serverTimestamp, getDocs, query, where, limit,
  deleteDoc
} from 'firebase/firestore';


// --- Utils ---
const shuffle = <T,>(array: T[]): T[] => [...array].sort(() => Math.random() - 0.5);

const getRandomElements = <T,>(array: T[], count: number): T[] => {
  return shuffle(array).slice(0, count);
};

const getAudioUrl = (voiceId: string) => {
  const prefix = voiceId.substring(0, 2) as CharKey;
  const folder = CHARACTERS[prefix].folder;
  // Use the ID from CSV directly as the filename base
  return `${BASE_VOICE_URL}${folder}/${voiceId}.wav`;
};

interface KikiStats {
  normal_play_count: number;
  hard_play_count: number;
  hell_play_count: number;
  challenge_normal_play_count: number;
  challenge_normal_high_score: number;
  challenge_hard_play_count: number;
  challenge_hard_high_score: number;
  challenge_hell_play_count: number;
  challenge_hell_high_score: number;
  online_2p_play_count: number;
  online_2p_win_count: number;
  online_3p_play_count: number;
  online_3p_win_count: number;
  online_4p_play_count: number;
  online_4p_win_count: number;
  asked: Record<string, number>;
  correct: Record<string, number>;
}

const DEFAULT_STATS: KikiStats = {
  normal_play_count: 0,
  hard_play_count: 0,
  hell_play_count: 0,
  challenge_normal_play_count: 0,
  challenge_normal_high_score: 0,
  challenge_hard_play_count: 0,
  challenge_hard_high_score: 0,
  challenge_hell_play_count: 0,
  challenge_hell_high_score: 0,
  online_2p_play_count: 0,
  online_2p_win_count: 0,
  online_3p_play_count: 0,
  online_3p_win_count: 0,
  online_4p_play_count: 0,
  online_4p_win_count: 0,
  asked: { ta: 0, ka: 0, ne: 0, so: 0 },
  correct: { ta: 0, ka: 0, ne: 0, so: 0 },
};

const getMyStats = (): KikiStats => {
  const raw = localStorage.getItem('kikimimi_my_stats');
  if (!raw) return DEFAULT_STATS;
  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATS,
      ...parsed,
      asked: { ...DEFAULT_STATS.asked, ...parsed.asked },
      correct: { ...DEFAULT_STATS.correct, ...parsed.correct },
    };
  } catch {
    return DEFAULT_STATS;
  }
};

const saveMyStats = (stats: KikiStats) => {
  localStorage.setItem('kikimimi_my_stats', JSON.stringify(stats));
};

// --- Helper to check if the online game is set (no one can catch up, or last round completed) ---
const checkOnlineGameSet = (players: any[], roundsToWin: number, currentRound: number): boolean => {
  const remainingRounds = Math.max(0, roundsToWin - currentRound);
  if (remainingRounds === 0) return true;

  // Sort players by total stars descending
  const sorted = [...players].sort((a: any, b: any) => (b.stars || 0) - (a.stars || 0));
  const s1 = sorted[0]?.stars || 0;
  const s2 = sorted[1]?.stars || 0;

  // A leader is a cold winner if no one can catch up even if they win all remaining rounds with 1st place (+3 stars each round)
  return s1 > (s2 + 3 * remainingRounds);
};

// --- Helper for Multiplayer Round Evaluation and Cold Win Check ---
const evaluateOnlineRound = (
  players: any[], 
  roundsToWin: number, 
  currentRound: number
) => {
  // Extract answered players and sort them by submitTime ascending
  const correctPlayers = players
    .filter((p: any) => p.status === 'answered')
    .sort((a: any, b: any) => (a.submitTime || 999) - (b.submitTime || 999));

  // Distribute stars based on ranking gradient: 1st => +3, 2nd => +2, 3rd => +1
  const updatedPlayers = players.map((p: any) => {
    const idx = correctPlayers.findIndex((cp: any) => cp.id === p.id);
    let scoreAdd = 0;
    if (idx === 0) scoreAdd = 3;
    else if (idx === 1) scoreAdd = 2;
    else if (idx === 2) scoreAdd = 1;
    
    return {
      ...p,
      stars: (p.stars || 0) + scoreAdd
    };
  });

  // Calculate if game set
  const isGameSet = checkOnlineGameSet(updatedPlayers, roundsToWin, currentRound);
  
  // ラウンド最後の時点では、必ずまずはラウンドリザルト（正解発表）画面を見せるため、
  // nextStatus は常に 'round_result' とします。
  const nextStatus = 'round_result';

  // Format ranking list for result display
  // Priority: 1) answered ascending, 2) fault, 3) timeout, 4) idle
  const sortedResults = [...updatedPlayers].sort((a: any, b: any) => {
    const order = { 'answered': 1, 'fault': 2, 'timeout': 3, 'idle': 4 };
    const statA = order[a.status as keyof typeof order] || 4;
    const statB = order[b.status as keyof typeof order] || 4;
    if (statA !== statB) return statA - statB;
    
    return (a.submitTime || 99) - (b.submitTime || 99);
  });

  const isDraw = correctPlayers.length === 0;

  const answerState = {
    isDraw,
    isCorrect: !isDraw,
    playerName: correctPlayers[0]?.name || '',
    playerId: correctPlayers[0]?.id || '',
    isGameSet: isGameSet,
    results: sortedResults.map((p: any, rank: number) => ({
      rank: rank + 1,
      id: p.id,
      name: p.name,
      status: p.status,
      submitTime: p.submitTime,
      starsAdded: p.id === correctPlayers[0]?.id ? 3 : (p.id === correctPlayers[1]?.id ? 2 : (p.id === correctPlayers[2]?.id ? 1 : 0)),
      stars: p.stars || 0,
      isCpu: p.isCpu || false
    }))
  };

  return {
    players: updatedPlayers,
    nextStatus,
    answerState
  };
};

// --- Component ---
export default function App() {
  const [gameState, setGameState] = useState<'start' | 'reveal' | 'main' | 'result' | 'challengeResult' | 'leaderboard' | 'onlineLobby' | 'onlineRoom' | 'onlineGame'>('start');
  const [gameMode, setGameMode] = useState<'normal' | 'hard' | 'hell'>('normal');
  const [targetChar, setTargetChar] = useState<CharKey>('ta');
  const [targetAnswers, setTargetAnswers] = useState<VoiceData[]>([]);
  const [sampleAnswers, setSampleAnswers] = useState<VoiceData[]>([]);
  const [otherCharVoices, setOtherCharVoices] = useState<Record<string, VoiceData[]>>({});
  const [options, setOptions] = useState<{ who: VoiceData[], where: VoiceData[], why?: VoiceData[], what: VoiceData[] }>({ who: [], where: [], what: [] });
  const [selections, setSelections] = useState<{ who: string | null, where: string | null, why?: string | null, what: string | null }>({ who: null, where: null, why: null, what: null });
  const [timeLeft, setTimeLeft] = useState(30);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMobileStep, setIsMobileStep] = useState(0); // 0: who, 1: where, 2: what, 3: confirm / for hard 4: what, 5: confirm
  const [win, setWin] = useState(false);
  const [bgmVolume, setBgmVolume] = useState(0.5);
  const [seVolume, setSeVolume] = useState(0.5);
  const [joinSeEnabled, setJoinSeEnabled] = useState<boolean>(() => {
    return localStorage.getItem('kikimimi_join_se_enabled') !== 'false';
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [isAccountRegistered, setIsAccountRegistered] = useState(false);
  const [accountIcon, setAccountIcon] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [unlockedIconInfo, setUnlockedIconInfo] = useState<{ charKey: string; name: string; image: string } | null>(null);

  // --- Challenge Mode & Leaderboard States ---
  const [isChallenge, setIsChallenge] = useState(false);
  const [currentRound, setCurrentRound] = useState(1);
  const [challengeScores, setChallengeScores] = useState<number[]>([]);
  const [repeatCount, setRepeatCount] = useState(0);
  const [playerName, setPlayerName] = useState('');

  // --- Online Multiplayer States ---
  const [onlinePlayerId, setOnlinePlayerId] = useState<string>('');
  const [onlinePlayerName, setOnlinePlayerName] = useState<string>('');
  const [activeRoomId, setActiveRoomId] = useState<string>('');
  const [activeRoom, setActiveRoom] = useState<any>(null);
  const [availableRooms, setAvailableRooms] = useState<any[]>([]);
  const [isLoadingRooms, setIsLoadingRooms] = useState<boolean>(false);
  const [isCopying, setIsCopying] = useState<boolean>(false);
  const [onlineLobbySubMode, setOnlineLobbySubMode] = useState<'options' | 'create' | 'join' | 'quick' | 'practiceConfig'>('options');
  const [createMaxPlayers, setCreateMaxPlayers] = useState<number>(2);
  const [createRoundsToWin, setCreateRoundsToWin] = useState<number>(3);
  const [createDifficulty, setCreateDifficulty] = useState<'normal' | 'hard' | 'hell'>('hard');
  const [createPassword, setCreatePassword] = useState<string>('');
  const [showCpuFillModal, setShowCpuFillModal] = useState<boolean>(false);
  const [cpuFillLevel, setCpuFillLevel] = useState<'easy' | 'normal'>('easy');
  const [practiceCpuLevel, setPracticeCpuLevel] = useState<'easy' | 'normal' | 'hell' | 'random'>('normal');
  const [practiceDifficulty, setPracticeDifficulty] = useState<'normal' | 'hard' | 'hell'>('normal');
  const [practiceRoundsToWin, setPracticeRoundsToWin] = useState<number>(3);
  const [practiceMaxPlayers, setPracticeMaxPlayers] = useState<number>(4);
  const cpuSchedulesRef = useRef<{ [cpuId: string]: { resolveTime: number; isCorrect: boolean; resolved: boolean } }>({});
  const [onlineCountdown, setOnlineCountdown] = useState<number>(3);
  const [onlineSampleTimeLeft, setOnlineSampleTimeLeft] = useState<number>(25);
  const [roundResultWaitTimeLeft, setRoundResultWaitTimeLeft] = useState<number>(30);
  const [onlineStatusMessage, setOnlineStatusMessage] = useState<string>('');
  const [isReadyForOnlineRound, setIsReadyForOnlineRound] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localToast, setLocalToast] = useState<{ message: string; key: number } | null>(null);
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>([]);
  const [leaderboardMode, setLeaderboardMode] = useState<'normal' | 'hard' | 'hell'>('normal');
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [hasSubmittedThisGame, setHasSubmittedThisGame] = useState(false);

  
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioSessionId = useRef(0);
  const isPlayingRef = useRef(false);
  const lastPlayedStartAtRef = useRef<number>(0);
  const lastObservedOnlineStatusRef = useRef<string>('');
  const lastObservedGameStateRef = useRef<string>('');
  const prevPlayerIdsRef = useRef<string[]>([]);

  const audioRefs = useRef<HTMLAudioElement[]>([]);
  const activeResolversRef = useRef<(() => void)[]>([]);
  const activeTimeoutsRef = useRef<NodeJS.Timeout[]>([]);

  // --- Web Audio API Support ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferCacheRef = useRef<Record<string, AudioBuffer>>({});
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  
  // 各キャラクター用の結合済み 1本化 AudioBuffer キャッシュ
  const charCombinedBuffersRef = useRef<Record<string, AudioBuffer>>({});
  // ターゲット・サンプル用の結合済みバッファ
  const targetCombinedBufferRef = useRef<AudioBuffer | null>(null);
  const sampleCombinedBufferRef = useRef<AudioBuffer | null>(null);

  // 5種類の事前作成済みサンプルのプリロード用
  const samplePreloadedAudiosRef = useRef<Record<string, HTMLAudioElement>>({});

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
    }
    return audioContextRef.current;
  }, []);

  const fetchAndDecode = useCallback(async (url: string): Promise<AudioBuffer | null> => {
    if (audioBufferCacheRef.current[url]) {
      return audioBufferCacheRef.current[url];
    }
    try {
      const ctx = getAudioContext();
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      return new Promise<AudioBuffer>((resolve, reject) => {
        ctx.decodeAudioData(
          arrayBuffer,
          (decoded: AudioBuffer) => {
            audioBufferCacheRef.current[url] = decoded;
            resolve(decoded);
          },
          (err) => {
            reject(err);
          }
        );
      });
    } catch (e) {
      console.error("fetchAndDecode failed for:", url, e);
      return null;
    }
  }, [getAudioContext]);

  // 複数のAudioBufferを指定された秒数(gapSeconds)の無音を挟んで1つに連結するヘルパー
  const concatenateAudioBuffers = useCallback((buffers: AudioBuffer[], gapSeconds: number): AudioBuffer | null => {
    if (buffers.length === 0) return null;
    const ctx = getAudioContext();
    const sampleRate = buffers[0].sampleRate;
    const numberOfChannels = Math.max(...buffers.map(b => b.numberOfChannels));
    const gapSamples = Math.floor(gapSeconds * sampleRate);

    // 総長の計算
    let totalSamples = 0;
    for (let i = 0; i < buffers.length; i++) {
      totalSamples += buffers[i].length;
      if (i < buffers.length - 1) {
        totalSamples += gapSamples;
      }
    }

    const outputBuffer = ctx.createBuffer(numberOfChannels, totalSamples, sampleRate);

    for (let channel = 0; channel < numberOfChannels; channel++) {
      const outputData = outputBuffer.getChannelData(channel);
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) {
        const b = buffers[i];
        if (channel < b.numberOfChannels) {
          outputData.set(b.getChannelData(channel), offset);
        }
        offset += b.length;
        if (i < buffers.length - 1) {
          offset += gapSamples;
        }
      }
    }

    return outputBuffer;
  }, [getAudioContext]);

  const stopAllAudio = useCallback(() => {
    audioSessionId.current++; // Incrementing ID cancels existing loops

    // Web Audio APIの再生を完全に停止
    activeSourcesRef.current.forEach(source => {
      try {
        source.onended = null;
        source.stop();
      } catch (e) {}
    });
    activeSourcesRef.current = [];

    // Cancel all active timeouts (safeguards, spacing, and error retries)
    activeTimeoutsRef.current.forEach(t => clearTimeout(t));
    activeTimeoutsRef.current = [];

    // Force resolve all pending play Promises to let the loops terminate immediately
    activeResolversRef.current.forEach(resolve => {
      try {
        resolve();
      } catch (e) {}
    });
    activeResolversRef.current = [];

    audioRefs.current.forEach(a => {
      try {
        a.pause();
        a.currentTime = 0;
        a.onended = null;
        a.onerror = null;
      } catch (e) {}
    });
    audioRefs.current = [];

    setIsPlaying(false);
    isPlayingRef.current = false;
  }, []);

  // 1本の結合済みAudioBufferをWeb Audio APIで再生する共通ヘルパー
  const playCombinedBuffer = useCallback(async (buffer: AudioBuffer, masterVolume: number): Promise<void> => {
    const ctx = getAudioContext();
    try {
      await ctx.resume();
    } catch (e) {}

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gainNode = ctx.createGain();
    gainNode.gain.value = masterVolume;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    activeSourcesRef.current.push(source);

    return new Promise<void>((resolve) => {
      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          source.onended = null;
          activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
          resolve();
        }
      };

      source.onended = () => safeResolve();

      try {
        source.start(0);
        // 万が一のブラウザの不具合、またはonendedが発火しない時のセーフガード
        const t = setTimeout(safeResolve, (buffer.duration * 1000) + 1000);
        activeTimeoutsRef.current.push(t);
      } catch (e) {
        safeResolve();
      }
    });
  }, [getAudioContext]);

  // 5つの事前作成済みサンプルからランダムに1波を再生する
  const playSampleVoice = useCallback(async (charKey: string) => {
    stopAllAudio();
    const sessionId = audioSessionId.current;
    setIsPlaying(true);
    isPlayingRef.current = true;

    try {
      const num = Math.floor(Math.random() * 5) + 1;
      const url = `assets/sample/${charKey}_sam${num}.wav`;
      
      let audio = samplePreloadedAudiosRef.current[url];
      if (!audio) {
        audio = new Audio(url);
      } else {
        audio.currentTime = 0;
      }
      
      audio.volume = seVolume;
      audioRefs.current.push(audio);

      await new Promise<void>((resolve) => {
        let resolved = false;
        const safeResolve = () => {
          if (!resolved) {
            resolved = true;
            audio!.onended = null;
            audio!.onerror = null;
            resolve();
          }
        };

        audio.onended = () => safeResolve();
        audio.onerror = (e) => {
          console.error("Audio play error for sample:", url, e);
          const t = setTimeout(safeResolve, 1500);
          activeTimeoutsRef.current.push(t);
        };

        audio.play().then(() => {
          audio!.playbackRate = 1.0;
          const t = setTimeout(() => {
            if (!resolved) {
              try {
                audio!.pause();
              } catch (e) {}
              safeResolve();
            }
          }, 15000);
          activeTimeoutsRef.current.push(t);
        }).catch((err) => {
          console.error("Audio play promise catch for sample:", url, err);
          const t = setTimeout(safeResolve, 1500);
          activeTimeoutsRef.current.push(t);
        });
      });
    } catch (e) {
      console.error("playSampleVoice failed:", e);
    } finally {
      if (sessionId === audioSessionId.current) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      }
    }
  }, [seVolume, stopAllAudio]);

  // Audio Control Logic
  const playCharSequence = useCallback(async (voices: VoiceData[]) => {
    stopAllAudio();
    const sessionId = audioSessionId.current;
    setIsPlaying(true);
    isPlayingRef.current = true;

    try {
      // 1. 各音声ファイルをフェッチ＆デコード
      const buffers: AudioBuffer[] = [];
      for (const v of voices) {
        if (sessionId !== audioSessionId.current) return;
        const url = getAudioUrl(v.voice);
        const b = await fetchAndDecode(url);
        if (b) {
          buffers.push(b);
        }
      }

      if (sessionId !== audioSessionId.current || buffers.length === 0) return;

      // 2. 1本のバッファに連結する（隙間は100ms = 0.1s）
      const combined = concatenateAudioBuffers(buffers, 0.1);
      if (!combined || sessionId !== audioSessionId.current) return;

      // 3. 再生
      await playCombinedBuffer(combined, seVolume);
    } catch (e) {
      console.error("playCharSequence buffer chain failed:", e);
    } finally {
      if (sessionId === audioSessionId.current) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      }
    }
  }, [fetchAndDecode, concatenateAudioBuffers, playCombinedBuffer, seVolume, stopAllAudio]);

  const playSimultaneous = useCallback(async () => {
    if (isPlayingRef.current) return;
    stopAllAudio(); // Clear previous
    setIsPlaying(true);
    isPlayingRef.current = true;
    const sessionId = audioSessionId.current;

    const ctx = getAudioContext();
    try {
      await ctx.resume();
    } catch (e) {}

    const allChars = [targetChar, ...(Object.keys(otherCharVoices) as CharKey[])];

    try {
      // 全キャラクター同時に (4音声) を1つのAudioBufferとして一斉再生する
      const playTasks = allChars.map(async (charKey) => {
        if (sessionId !== audioSessionId.current) return;

        // すでにuseEffectでプリロード＆結合されているバッファを取得
        let buffer = charCombinedBuffersRef.current[charKey];
        if (!buffer) {
          // 万が一キャッシュされていなければ、その場で作る
          const voices = charKey === targetChar ? targetAnswers : otherCharVoices[charKey];
          if (!voices || voices.length === 0) return;
          const buffers: AudioBuffer[] = [];
          for (const v of voices) {
            const url = getAudioUrl(v.voice);
            const b = await fetchAndDecode(url);
            if (b) buffers.push(b);
          }
          if (buffers.length === 0 || sessionId !== audioSessionId.current) return;
          const combined = concatenateAudioBuffers(buffers, 0.1);
          if (combined) {
            charCombinedBuffersRef.current[charKey] = combined;
            buffer = combined;
          } else {
            return;
          }
        }

        if (!buffer || sessionId !== audioSessionId.current) return;

        // 一発再生！
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gainNode = ctx.createGain();
        gainNode.gain.value = seVolume;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        activeSourcesRef.current.push(source);

        await new Promise<void>((resolve) => {
          let resolved = false;
          const safeResolve = () => {
            if (!resolved) {
              resolved = true;
              source.onended = null;
              activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
              resolve();
            }
          };

          source.onended = () => safeResolve();

          try {
            source.start(0);
            // セーフガード
            const t = setTimeout(safeResolve, (buffer.duration * 1000) + 1000);
            activeTimeoutsRef.current.push(t);
          } catch (e) {
            safeResolve();
          }
        });
      });

      await Promise.all(playTasks);
    } catch (e) {
      console.error("playSimultaneous dynamic combination failed:", e);
    } finally {
      if (sessionId === audioSessionId.current) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      }
    }
  }, [targetChar, otherCharVoices, targetAnswers, fetchAndDecode, concatenateAudioBuffers, getAudioContext, seVolume, stopAllAudio]);

  // --- 5種類のサンプル音声をバックグラウンドで一発先行プリロードする ---
  useEffect(() => {
    const chars = ['ta', 'ka', 'ne', 'so'];
    chars.forEach((charKey) => {
      for (let num = 1; num <= 5; num++) {
        const url = `assets/sample/${charKey}_sam${num}.wav`;
        if (!samplePreloadedAudiosRef.current[url]) {
          try {
            const audio = new Audio(url);
            audio.preload = "auto";
            audio.load();
            samplePreloadedAudiosRef.current[url] = audio;
          } catch (e) {
            console.error("Early background sample load failed:", url, e);
          }
        }
      }
    });
  }, []);

  // --- 読み込み遅延に負けないための事前プリロード（バックグラウンド先行ロード） ---
  useEffect(() => {
    const urls: string[] = [];
    
    // 現在の問題の正解、および他キャラの全音声を抽出
    targetAnswers?.forEach(v => {
      if (v?.voice) urls.push(getAudioUrl(v.voice));
    });
    if (otherCharVoices) {
      Object.keys(otherCharVoices).forEach((charKey) => {
        const voices = otherCharVoices[charKey];
        voices?.forEach(v => {
          if (v?.voice) urls.push(getAudioUrl(v.voice));
        });
      });
    }

    const uniqueUrls = Array.from(new Set(urls));

    uniqueUrls.forEach(url => {
      // 自主デコードキャッシュ
      if (!audioBufferCacheRef.current[url]) {
        fetchAndDecode(url).catch(e => {
          console.error("Early background decode failed:", url, e);
        });
      }
    });

    // キャッシュの掃除 (サンプル音声は消さずに保護)
    Object.keys(audioBufferCacheRef.current).forEach(url => {
      if (!url.startsWith('assets/sample/') && !uniqueUrls.includes(url)) {
        delete audioBufferCacheRef.current[url];
      }
    });
  }, [targetAnswers, otherCharVoices, fetchAndDecode]);

  // キャラクターごとのスロット音声（who -> where -> what）の結合バッファを、問題データ決定時に先行作成しておく
  useEffect(() => {
    if (!targetChar || !targetAnswers) return;

    const allChars = [targetChar, ...(Object.keys(otherCharVoices || {}) as CharKey[])];
    
    allChars.forEach(async (charKey) => {
      const voices = charKey === targetChar ? targetAnswers : otherCharVoices[charKey];
      if (!voices) return;

      try {
        const buffers = await Promise.all(
          voices.map(async (v) => {
            const url = getAudioUrl(v.voice);
            return await fetchAndDecode(url);
          })
        );
        const validBuffers = buffers.filter((b): b is AudioBuffer => b !== null);
        if (validBuffers.length > 0) {
          const combined = concatenateAudioBuffers(validBuffers, 0.1); // 100ms gap
          if (combined) {
            charCombinedBuffersRef.current[charKey] = combined;
          }
        }
      } catch (e) {
        console.error("Combined preload failed for char:", charKey, e);
      }
    });

    // ターゲット回答用の結合バッファも事前に作っておく
    const preloadDirects = async () => {
      try {
        if (targetAnswers) {
          const tBufs = await Promise.all(targetAnswers.map(v => fetchAndDecode(getAudioUrl(v.voice))));
          const validTBuffers = tBufs.filter((b): b is AudioBuffer => b !== null);
          if (validTBuffers.length > 0) {
            targetCombinedBufferRef.current = concatenateAudioBuffers(validTBuffers, 0.1);
          }
        }
      } catch (e) {
        console.error("Direct combined preloads failed:", e);
      }
    };
    
    preloadDirects();
  }, [targetChar, targetAnswers, otherCharVoices, fetchAndDecode, concatenateAudioBuffers]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(err => {
        console.error("Error attempting to enable fullscreen:", err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      }).catch(err => {
        console.error("Error attempting to exit fullscreen:", err);
      });
    }
  };

  const checkNewIconUnlock = useCallback((
    stats: KikiStats, 
    justClearedMode?: 'normal' | 'hard' | 'hell', 
    justPlayedChallengeMode?: 'normal' | 'hard' | 'hell'
  ) => {
    const currentUnlocked: string[] = JSON.parse(localStorage.getItem('kikimimi_unlocked_icons') || '[]');
    const newUnlocks: string[] = [];

    // 浦和のお姉さん（春日部つむぎ）＝ ka: 通常プレイの「NORMAL」を1回クリア
    if ((justClearedMode === 'normal' || stats.normal_play_count >= 1) && !currentUnlocked.includes('ka')) {
      newUnlocks.push('ka');
    }
    // 富良野のお兄さん（玄野武宏） = ta: 通常プレイの「HARD」を1回クリア
    if ((justClearedMode === 'hard' || stats.hard_play_count >= 1) && !currentUnlocked.includes('ta')) {
      newUnlocks.push('ta');
    }
    // 北谷町の漁師（麒ケ島宗麟） = so: 通常プレイの「HELL」を1回クリア
    if ((justClearedMode === 'hell' || stats.hell_play_count >= 1) && !currentUnlocked.includes('so')) {
      newUnlocks.push('so');
    }
    // アキバ的メイドさん（猫使ビィ） = ne: CHALLENGEのNORMALを1回プレイ
    if ((justPlayedChallengeMode === 'normal' || stats.challenge_normal_play_count >= 1) && !currentUnlocked.includes('ne')) {
      newUnlocks.push('ne');
    }

    if (newUnlocks.length > 0) {
      const updated = [...currentUnlocked, ...newUnlocks];
      localStorage.setItem('kikimimi_unlocked_icons', JSON.stringify(updated));
      
      const targetKey = newUnlocks[0];
      const charInfo = CHARACTERS[targetKey as CharKey];
      setUnlockedIconInfo({
        charKey: targetKey,
        name: charInfo.name,
        image: charInfo.image
      });

      const se = new Audio("assets/se/iconget.mp3");
      se.volume = seVolume;
      se.play().catch(e => console.error("SE iconget play failed", e));
    }
  }, [seVolume]);

  useEffect(() => {
    const stats = getMyStats();
    const currentUnlocked: string[] = JSON.parse(localStorage.getItem('kikimimi_unlocked_icons') || '[]');
    let updated = [...currentUnlocked];
    let changed = false;

    if (stats.normal_play_count >= 1 && !updated.includes('ka')) {
      updated.push('ka');
      changed = true;
    }
    if (stats.hard_play_count >= 1 && !updated.includes('ta')) {
      updated.push('ta');
      changed = true;
    }
    if (stats.hell_play_count >= 1 && !updated.includes('so')) {
      updated.push('so');
      changed = true;
    }
    if (stats.challenge_normal_play_count >= 1 && !updated.includes('ne')) {
      updated.push('ne');
      changed = true;
    }

    if (changed) {
      localStorage.setItem('kikimimi_unlocked_icons', JSON.stringify(updated));
    }
  }, []);

  // --- Online Battle Initialization ---
  useEffect(() => {
    const initOnlineAuth = async () => {
      try {
        const uid = await loginAnonymously();
        setOnlinePlayerId(uid);
        
        const isReg = localStorage.getItem('kikimimi_account_registered') === 'true';
        const savedIcon = localStorage.getItem('kikimimi_account_icon') || null;
        
        setIsAccountRegistered(isReg);
        setAccountIcon(savedIcon);

        const savedName = localStorage.getItem('kikimimi_online_name') || '';
        if (savedName) {
          setOnlinePlayerName(savedName);
          setPlayerName(savedName);
        } else {
          const defaultName = `guest${Math.floor(Math.random() * 900) + 100}`;
          setOnlinePlayerName(defaultName);
          setPlayerName(defaultName);
          localStorage.setItem('kikimimi_online_name', defaultName);
        }
      } catch (err) {
        console.error("Online auth initialization failed:", err);
      }
    };
    initOnlineAuth();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && onlinePlayerId) {
      setTimeout(() => {
        joinOnlineRoom(roomFromUrl);
      }, 1000);
    }
  }, [onlinePlayerId]);

  // --- Online Battle Firestore OnSnapshot Listener ---
  useEffect(() => {
    if (!activeRoomId || isDummy || !db) return;

    const roomRef = doc(db, 'rooms', activeRoomId);
    const unsubscribe = onSnapshot(roomRef, (snapshot) => {
      if (!snapshot.exists()) {
        setActiveRoom(null);
        setActiveRoomId('');
        if (gameState === 'onlineRoom' || gameState === 'onlineGame') {
          setOnlineStatusMessage('対戦ルームが解散または削除されました。');
          setGameState('start');
        }
        return;
      }

      const data = snapshot.data();
      setActiveRoom(data);

      // Status State Synced Changes
      if (data.status === 'sampling' && gameState === 'onlineRoom') {
        setGameState('onlineGame');
        stopAllAudio();
        setSelections({ who: null, where: null, why: null, what: null });
        setIsReadyForOnlineRound(false);
        setOnlineCountdown(3);
      }

      if (data.currentProblem) {
        setTargetChar(data.currentProblem.targetChar);
        setTargetAnswers(data.currentProblem.targetAnswers);
        setSampleAnswers(data.currentProblem.sampleAnswers);
        setOtherCharVoices(data.currentProblem.otherCharVoices);
        setOptions(data.currentProblem.options);
        setGameMode(data.difficulty);
      }
      
      if (data.currentRound) {
        setCurrentRound(data.currentRound);
      }
    }, (error) => {
      console.error(error);
    });

    return () => {
      unsubscribe();
    };
  }, [activeRoomId, gameState]);

  // --- Online Room Member Join SE Notification ---
  useEffect(() => {
    if (!activeRoom || !activeRoomId) {
      prevPlayerIdsRef.current = [];
      return;
    }

    const isHost = activeRoom.hostId === onlinePlayerId;
    const isWaiting = activeRoom.status === 'waiting';

    if (isHost && isWaiting) {
      const currentPlayerIds = activeRoom.players.map((p: any) => p.id);
      
      if (prevPlayerIdsRef.current.length > 0) {
        const addedPlayers = currentPlayerIds.filter((id: string) => !prevPlayerIdsRef.current.includes(id) && id !== onlinePlayerId);
        if (addedPlayers.length > 0 && joinSeEnabled) {
          const se = new Audio("assets/se/in.mp3");
          se.volume = seVolume;
          se.play().catch(e => console.error("Room join SE play failed", e));
        }
      }
      prevPlayerIdsRef.current = currentPlayerIds;
    } else {
      prevPlayerIdsRef.current = activeRoom.players.map((p: any) => p.id);
    }
  }, [activeRoom?.players, activeRoom?.status, activeRoom?.hostId, onlinePlayerId, joinSeEnabled, seVolume, activeRoomId]);

  // Host-Driven Automatic Match Sequence Start
  useEffect(() => {
    if (!activeRoom || !activeRoomId) return;
    const isHost = activeRoom.hostId === onlinePlayerId;
    if (!isHost) return;

    if (activeRoom.status === 'waiting') {
      const currentPlayersCount = activeRoom.players.length;
      const targetCount = activeRoom.maxPlayers;
      
      if (currentPlayersCount >= targetCount) {
        startOnlineGameSequence();
      }
    }
  }, [activeRoom?.players.length, activeRoom?.status]);

  // 25 seconds listening countdown (Sampling Stage)
  useEffect(() => {
    if (!activeRoom || !activeRoomId) return;
    if (activeRoom.status !== 'sampling') return;

    const timer = setInterval(() => {
      const elapsed = Date.now() - (activeRoom.samplingStartAt || Date.now());
      const left = Math.max(0, 25 - Math.floor(elapsed / 1000));
      setOnlineSampleTimeLeft(left);

      if (left <= 0) {
        clearInterval(timer);
        if (activeRoom.hostId === onlinePlayerId) {
          transitionToCountdown();
        }
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [activeRoom?.status, activeRoom?.samplingStartAt]);

  // 30 seconds wait in round_result stage (when other humans exist in room)
  useEffect(() => {
    if (!activeRoom || !activeRoomId) return;
    if (activeRoom.status !== 'round_result') {
      setRoundResultWaitTimeLeft(30);
      return;
    }

    const hasOtherHuman = activeRoom.players.some((p: any) => !p.isCpu && p.id !== onlinePlayerId);
    if (!hasOtherHuman) {
      return;
    }

    const timer = setInterval(() => {
      setRoundResultWaitTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          if (activeRoom.hostId === onlinePlayerId) {
            nextOnlineRound();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [activeRoom?.status, activeRoom?.players]);

  // Host transition list listening for Ready Check in Sampling stage
  useEffect(() => {
    if (!activeRoom || !activeRoomId) return;
    if (activeRoom.status !== 'sampling') return;
    if (activeRoom.hostId !== onlinePlayerId) return;

    // CPU以外の全「人間」のプレイヤーがReadyならカウントダウンへ移行（CPUはあらかじめReady扱い）
    const allReady = activeRoom.players.every((p: any) => p.isCpu || p.isReady === true);
    if (allReady && activeRoom.players.length > 0) {
      transitionToCountdown();
    }
  }, [activeRoom?.players, activeRoom?.status]);

  // Ready Countdown Stage (3 seconds)
  useEffect(() => {
    if (!activeRoom || !activeRoomId) return;
    if (activeRoom.status !== 'ready_countdown') return;

    setOnlineCountdown(3);
    const startT = activeRoom.countdownStartAt || Date.now();

    const timer = setInterval(() => {
      const elapsed = Date.now() - startT;
      const count = Math.max(0, 3 - Math.floor(elapsed / 1000));
      setOnlineCountdown(count);

      if (count <= 0) {
        clearInterval(timer);
        if (activeRoom.hostId === onlinePlayerId) {
          triggerPlayPhase();
        }
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [activeRoom?.status, activeRoom?.countdownStartAt]);

  // Playing Stage limit handling (Automatic server timeout sync) and CPU Actions Scheduler
  useEffect(() => {
    if (gameState !== 'onlineGame') return;
    if (!activeRoom || !activeRoomId) return;
    if (activeRoom.status !== 'playing') {
      cpuSchedulesRef.current = {};
      return;
    }

    const maxTime = activeRoom.difficulty === 'hell' ? 60 : (activeRoom.difficulty === 'hard' ? 45 : 30);
    
    // playingStartAt が更新されたときのみ再生を実行する
    if (activeRoom.playingStartAt && lastPlayedStartAtRef.current !== activeRoom.playingStartAt) {
      lastPlayedStartAtRef.current = activeRoom.playingStartAt;
      playSimultaneous();
    }

    // ホストの場合、生きている全CPUの解答スケジュールを作成
    const isHost = activeRoom.hostId === onlinePlayerId;
    if (isHost) {
      const scheds: typeof cpuSchedulesRef.current = {};
      activeRoom.players.forEach((p: any) => {
        if (p.isCpu && p.status === 'idle') {
          let accuracy = 0.6;
          let resolveTime = 12;

          if (p.cpuLevel === 'easy') {
            // 初心者（おバカ）: おそく(半分〜4/3)、正答率30%
            resolveTime = Math.floor(maxTime * 0.5 + Math.random() * maxTime * 0.35);
            if (resolveTime >= maxTime) {
              resolveTime = maxTime - 2; // 制限時間オーバーを防ぐ
            }
            accuracy = 0.3;
          } else if (p.cpuLevel === 'normal') {
            // 聞き耳上手（ふつう）: 回答中速度、正答率60%
            resolveTime = Math.floor(10 + Math.random() * 8);
            accuracy = 0.6;
          } else if (p.cpuLevel === 'hell') {
            // 聖徳太子（HELL級）: 解答スピードが異常に早く（5〜7秒）、正答率85%
            resolveTime = Math.floor(5 + Math.random() * 2.5);
            accuracy = 0.85;
          }

          scheds[p.id] = {
            resolveTime,
            isCorrect: Math.random() < accuracy,
            resolved: false
          };
        }
      });
      cpuSchedulesRef.current = scheds;
    }

    const timer = setInterval(() => {
      const elapsed = Date.now() - (activeRoom.playingStartAt || Date.now());
      const elapsedSeconds = Math.floor(elapsed / 1000);
      const left = Math.max(0, maxTime - elapsedSeconds);
      setTimeLeft(left);

      // CPU解答の毎秒スケジュールチェック (ホストのみ実行)
      if (isHost) {
        Object.keys(cpuSchedulesRef.current).forEach((cpuId) => {
          const s = cpuSchedulesRef.current[cpuId];
          if (s && !s.resolved && elapsedSeconds >= s.resolveTime) {
            s.resolved = true;
            const cpuPlayer = activeRoom.players.find((p: any) => p.id === cpuId);
            if (cpuPlayer && cpuPlayer.status === 'idle') {
              resolveCpuAnswer(cpuId, cpuPlayer.name, s.isCorrect);
            }
          }
        });
      }

      if (left <= 0) {
        clearInterval(timer);
        if (isHost) {
          handleOnlineRoundTimeout();
        }
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [gameState, activeRoom?.status, activeRoom?.playingStartAt, playSimultaneous, activeRoomId, onlinePlayerId]);

  // Handle auto-fade-out for game-event local notifications
  useEffect(() => {
    if (localToast) {
      const timer = setTimeout(() => {
        setLocalToast(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [localToast]);

  // Watch for real-time multiplayer correct/fault notifications
  useEffect(() => {
    if (activeRoom?.latestNotification) {
      const notif = activeRoom.latestNotification;
      const ageMs = Date.now() - notif.timestamp;
      if (ageMs < 5000) {
        const actionText = notif.action === 'correct' ? '正解しました！' : 'お手付きしました！';
        setLocalToast({
          message: `${notif.name} が${actionText}`,
          key: notif.timestamp
        });
      }
    }
  }, [activeRoom?.latestNotification]);

  // 新ラウンド（sampling）が開始された際のクライアント側ローカル状態（Ready状態、選択肢など）の初期化
  useEffect(() => {
    if (!activeRoom) return;
    if (activeRoom.status === 'sampling') {
      setSelections({ who: null, where: null, why: null, what: null });
      setIsReadyForOnlineRound(false);
      setOnlineCountdown(3);
    }
  }, [activeRoom?.status, activeRoom?.currentRound]);

  // タイトル画面や待機部屋、ロビーに戻った際、再生中のすべての音声を強制停止する
  useEffect(() => {
    if (gameState === 'start' || gameState === 'onlineLobby' || gameState === 'onlineRoom' || gameState === 'leaderboard') {
      stopAllAudio();
    }
  }, [gameState, stopAllAudio]);

  // カウントダウンが始まったら、現在再生中のサンプルボイスを打ち切る
  useEffect(() => {
    if (activeRoom?.status === 'ready_countdown') {
      stopAllAudio();
    }
  }, [activeRoom?.status, stopAllAudio]);

  // オンライン対戦やチャレンジのステータス変化等に応じたSE自動再生
  useEffect(() => {
    // 1) オンライン対戦のステータス監視
    if (activeRoom && activeRoomId) {
      const currentStatus = activeRoom.status;
      const lastStatus = lastObservedOnlineStatusRef.current;

      if (currentStatus !== lastStatus) {
        lastObservedOnlineStatusRef.current = currentStatus;

        // ラウンド結果が出たとき
        if (currentStatus === 'round_result') {
          stopAllAudio(); // 既存の再生をクリア
          const isDraw = activeRoom.answerState?.isDraw;
          const winnerId = activeRoom.answerState?.playerId;

          if (isDraw) {
            // ラウンド引き分け
            const se = new Audio("assets/se/draw.mp3");
            se.volume = seVolume;
            se.play().catch(e => console.error("SE draw play failed", e));
          } else if (winnerId === onlinePlayerId) {
            // 自分がラウンド勝利（一番初めに正答した人）
            const se = new Audio("assets/se/win.mp3");
            se.volume = seVolume;
            se.play().catch(e => console.error("SE win play failed", e));
          } else {
            // 他人に先に正解された（敗北）
            const se = new Audio("assets/se/lose.mp3");
            se.volume = seVolume;
            se.play().catch(e => console.error("SE lose play failed", e));
          }
        }

        // オンライン対戦がゲームオーバーになったとき（最終結果画面）
        if (currentStatus === 'game_over') {
          stopAllAudio();
          // 順位を判定
          const rankedPlayers = [...activeRoom.players].sort((a: any, b: any) => b.stars - a.stars);
          const myRankIndex = rankedPlayers.findIndex((p: any) => p.id === onlinePlayerId);

          if (myRankIndex === 0 || myRankIndex === 1) {
            // 1位、2位
            const se = new Audio("assets/se/win2.mp3");
            se.volume = seVolume;
            se.play().catch(e => console.error("SE win2 play failed", e));
          } else {
            // 3位、4位
            const se = new Audio("assets/se/lose2.mp3");
            se.volume = seVolume;
            se.play().catch(e => console.error("SE lose2 play failed", e));
          }

          // オンライン統計アップデート
          const stats = getMyStats();
          const playerCount = activeRoom.players.length;
          const isWinner = myRankIndex === 0;

          if (playerCount === 2) {
            stats.online_2p_play_count += 1;
            if (isWinner) stats.online_2p_win_count += 1;
          } else if (playerCount === 3) {
            stats.online_3p_play_count += 1;
            if (isWinner) stats.online_3p_win_count += 1;
          } else if (playerCount >= 4) {
            stats.online_4p_play_count += 1;
            if (isWinner) stats.online_4p_win_count += 1;
          }
          saveMyStats(stats);
          checkNewIconUnlock(stats);
        }
      }
    }

    // 2) ローカルの gameState 監視 (主にチャレンジモードなど)
    const currentGameState = gameState;
    const lastGameState = lastObservedGameStateRef.current;

    if (currentGameState !== lastGameState) {
      lastObservedGameStateRef.current = currentGameState;

      if (currentGameState === 'challengeResult') {
        stopAllAudio();
        const totalScore = challengeScores.reduce((sum, s) => sum + s, 0);
        const isWorstRank = isChallenge ? (totalScore < 9000) : (totalScore < 3000);

        if (isWorstRank) {
          const se = new Audio("assets/se/lose2.mp3");
          se.volume = seVolume;
          se.play().catch(e => console.error("SE lose2 play failed", e));
        } else {
          const se = new Audio("assets/se/win2.mp3");
          se.volume = seVolume;
          se.play().catch(e => console.error("SE win2 play failed", e));
        }
      }
    }
  }, [activeRoom?.status, activeRoom?.answerState, activeRoom?.players, gameState, challengeScores, onlinePlayerId, seVolume, stopAllAudio, isChallenge]);

  // チャレンジ完了時のハイスコア保存
  useEffect(() => {
    if (gameState === 'challengeResult' && isChallenge) {
      const totalScore = challengeScores.reduce((sum, s) => sum + s, 0);
      const key = `kikimimi_my_highscore_${gameMode}`;
      const savedHighScore = localStorage.getItem(key);
      const currentHighest = savedHighScore ? parseInt(savedHighScore, 10) : 0;
      if (totalScore > currentHighest) {
        localStorage.setItem(key, totalScore.toString());
      }
    }
  }, [gameState, isChallenge, challengeScores, gameMode]);

  // Online helper sub-actions
  const saveOnlinePlayerName = (name: string) => {
    const clean = name.trim().slice(0, 8);
    setOnlinePlayerName(clean);
    setPlayerName(clean);
    localStorage.setItem('kikimimi_online_name', clean);
  };

  const generateRoomId = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  const resolveCpuAnswer = async (cpuId: string, name: string, isCorrect: boolean) => {
    if (!activeRoomId || !activeRoom) return;
    if (activeRoom.status !== 'playing') return;

    if (isDummy || !db) {
      const rData = { ...activeRoom };
      if (rData.status !== 'playing') return;

      const currentPlayers = [...rData.players];
      const cpuIndex = currentPlayers.findIndex((p: any) => p.id === cpuId);
      if (cpuIndex === -1 || currentPlayers[cpuIndex].status !== 'idle') return;

      const elapsedSec = Math.round(((Date.now() - rData.playingStartAt) / 1000) * 10) / 10;

      currentPlayers[cpuIndex].status = isCorrect ? 'answered' : 'fault';
      currentPlayers[cpuIndex].submitTime = elapsedSec;
      currentPlayers[cpuIndex].isCorrectAnswer = isCorrect;

      const allDone = currentPlayers.every((p: any) => p.status !== 'idle');

      let nextRoomState = { ...rData, players: currentPlayers };
      
      nextRoomState.latestNotification = {
        name: name,
        action: isCorrect ? 'correct' : 'fault',
        timestamp: Date.now()
      };

      if (allDone) {
        const evaluated = evaluateOnlineRound(currentPlayers, rData.roundsToWin, rData.currentRound);
        nextRoomState.players = evaluated.players;
        nextRoomState.status = evaluated.nextStatus;
        nextRoomState.answerState = evaluated.answerState;
      }
      setActiveRoom(nextRoomState);
      return;
    }

    try {
      const roomRef = doc(db, 'rooms', activeRoomId);
      await runTransaction(db, async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists()) return;

        const rData = roomDoc.data();
        if (rData.status !== 'playing') return;

        const currentPlayers = [...rData.players];
        const cpuIndex = currentPlayers.findIndex((p: any) => p.id === cpuId);
        if (cpuIndex === -1 || currentPlayers[cpuIndex].status !== 'idle') return;

        const elapsedSec = Math.round(((Date.now() - rData.playingStartAt) / 1000) * 10) / 10;

        currentPlayers[cpuIndex].status = isCorrect ? 'answered' : 'fault';
        currentPlayers[cpuIndex].submitTime = elapsedSec;
        currentPlayers[cpuIndex].isCorrectAnswer = isCorrect;

        const allDone = currentPlayers.every((p: any) => p.status !== 'idle');

        const latestNotification = {
          name: name,
          action: isCorrect ? 'correct' : 'fault',
          timestamp: Date.now()
        };

        if (allDone) {
          const evaluated = evaluateOnlineRound(currentPlayers, rData.roundsToWin, rData.currentRound);
          transaction.update(roomRef, {
            players: evaluated.players,
            status: evaluated.nextStatus,
            answerState: evaluated.answerState,
            latestNotification,
            updatedAt: new Date().toISOString()
          });
        } else {
          transaction.update(roomRef, {
            players: currentPlayers,
            latestNotification,
            updatedAt: new Date().toISOString()
          });
        }
      });
    } catch (e) {
      console.error("CPU resolve answer error:", e);
    }
  };

  const startWithCurrentPlayers = async () => {
    if (!activeRoomId || !activeRoom) return;
    try {
      const currentCount = activeRoom.players.length;
      if (currentCount < 1) return;

      const updatePayload = {
        maxPlayers: currentCount,
        updatedAt: new Date().toISOString()
      };

      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        const updatedRoom = { ...activeRoom, maxPlayers: currentCount };
        setActiveRoom(updatedRoom);
        setTimeout(() => {
          startOnlineGameSequence();
        }, 100);
      }
    } catch (err) {
      console.error("Failed to start with current players:", err);
    }
  };

  const fillWithCpu = async (cpuLevel: 'easy' | 'normal') => {
    if (!activeRoomId || !activeRoom) return;
    try {
      const currentPlayers = [...activeRoom.players];
      const neededCount = activeRoom.maxPlayers - currentPlayers.length;
      if (neededCount <= 0) return;

      const cpuNamePrefix = cpuLevel === 'easy' ? 'CPU（おバカ）' : 'CPU（ふつう）';

      for (let i = 0; i < neededCount; i++) {
        const cpuId = `cpu_${Math.random().toString(36).substring(2, 8)}`;
        currentPlayers.push({
          id: cpuId,
          name: `${cpuNamePrefix} ${i + 1}`,
          isCpu: true,
          cpuLevel: cpuLevel,
          stars: 0,
          isHost: false,
          isReady: true,
          status: 'idle'
        });
      }

      const updatePayload = {
        players: currentPlayers,
        updatedAt: new Date().toISOString()
      };

      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        const updatedRoom = { ...activeRoom, players: currentPlayers };
        setActiveRoom(updatedRoom);
        setTimeout(() => {
          startOnlineGameSequence();
        }, 100);
      }
      setShowCpuFillModal(false);
    } catch (err) {
      console.error("Failed to fill with CPU:", err);
    }
  };

  const startPracticeGame = async (
    cpuLevel: 'easy' | 'normal' | 'hell' | 'random',
    difficulty: 'normal' | 'hard' | 'hell',
    roundsToWin: number,
    numPlayers: number
  ) => {
    if (!onlinePlayerName.trim()) {
      alert("ニックネームを入力してください。");
      return;
    }
    setIsLoadingRooms(true);
    const newRoomId = 'SOLO_' + generateRoomId();

    const hostPlayer = {
      id: onlinePlayerId,
      name: onlinePlayerName.trim(),
      stars: 0,
      isHost: true,
      isReady: true,
      status: 'idle'
    };

    const playersArray: any[] = [hostPlayer];
    const totalCpuCount = numPlayers - 1;

    for (let i = 0; i < totalCpuCount; i++) {
      const actualLevel = cpuLevel === 'random' 
        ? (['easy', 'normal', 'hell'] as const)[Math.floor(Math.random() * 3)]
        : cpuLevel;
      const levelLabel = actualLevel === 'easy' ? 'おバカ' : actualLevel === 'normal' ? 'ふつう' : '聖徳太子';

      playersArray.push({
        id: `cpu_${Math.random().toString(36).substring(2, 8)}`,
        name: `CPU（${levelLabel}） ${i + 1}`,
        isCpu: true,
        cpuLevel: actualLevel,
        stars: 0,
        isHost: false,
        isReady: true,
        status: 'idle'
      });
    }

    const roomData = {
      roomId: newRoomId,
      hostId: onlinePlayerId,
      hostName: onlinePlayerName.trim(),
      maxPlayers: numPlayers,
      roundsToWin: roundsToWin,
      difficulty: difficulty,
      password: '',
      status: 'waiting',
      players: playersArray,
      currentRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      samplingStartAt: 0,
      countdownStartAt: 0,
      currentProblem: null,
      answerState: null
    };

    try {
      if (!isDummy && db) {
        await setDoc(doc(db, 'rooms', newRoomId), roomData);
      }
      setActiveRoomId(newRoomId);
      setActiveRoom(roomData);
      setGameState('onlineRoom');
      setOnlineStatusMessage('');
    } catch (err) {
      console.error("Failed to start solo game:", err);
      setActiveRoomId(newRoomId);
      setActiveRoom(roomData);
      setGameState('onlineRoom');
    } finally {
      setIsLoadingRooms(false);
    }
  };

  const createOnlineRoom = async () => {
    if (!onlinePlayerName.trim()) {
      alert("ニックネームを入力してください。");
      return;
    }
    setIsLoadingRooms(true);
    const newRoomId = generateRoomId();
    
    const hostPlayer = {
      id: onlinePlayerId,
      name: onlinePlayerName.trim(),
      stars: 0,
      isHost: true,
      isReady: true,
      status: 'idle',
      icon: accountIcon || 'null'
    };

    const roomData = {
      roomId: newRoomId,
      hostId: onlinePlayerId,
      hostName: onlinePlayerName.trim(),
      maxPlayers: createMaxPlayers,
      roundsToWin: createRoundsToWin,
      difficulty: createDifficulty,
      password: createPassword.trim(),
      status: 'waiting',
      players: [hostPlayer],
      currentRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      samplingStartAt: 0,
      countdownStartAt: 0,
      currentProblem: null,
      answerState: null
    };

    try {
      if (!isDummy && db) {
        await setDoc(doc(db, 'rooms', newRoomId), roomData);
      }
      setActiveRoomId(newRoomId);
      setActiveRoom(roomData);
      setGameState('onlineRoom');
      setOnlineStatusMessage('');
    } catch (err) {
      console.error("Failed to create room:", err);
      setActiveRoomId(newRoomId);
      setActiveRoom(roomData);
      setGameState('onlineRoom');
    } finally {
      setIsLoadingRooms(false);
    }
  };

  const refreshAvailableRooms = async () => {
    setIsLoadingRooms(true);
    if (isDummy || !db) {
      setAvailableRooms([
        { roomId: "TEST", hostName: "キキミミ公式Bot", maxPlayers: 2, players: [{name: "公式Bot"}], difficulty: "hard", roundsToWin: 3, password: "", status: "waiting" }
      ]);
      setIsLoadingRooms(false);
      return;
    }
    try {
      const q = query(
        collection(db, 'rooms'),
        where('status', '==', 'waiting'),
        limit(15)
      );
      const snap = await getDocs(q);
      const rooms: any[] = [];
      snap.forEach(docSnap => {
        rooms.push(docSnap.data());
      });
      setAvailableRooms(rooms);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingRooms(false);
    }
  };

  const joinOnlineRoom = async (roomId: string, inputPassword?: string) => {
    if (!onlinePlayerName.trim()) {
      alert("ニックネームを入力してください。");
      return;
    }
    const cleanRoomId = roomId.toUpperCase().trim();
    if (!cleanRoomId) return;

    setIsLoadingRooms(true);
    const pass = inputPassword || '';

    try {
      let rData: any = null;
      if (!isDummy && db) {
        const roomRef = doc(db, 'rooms', cleanRoomId);
        const snap = await getDoc(roomRef);
        if (!snap.exists()) {
          alert("指定された対戦ルームが見つかりません。");
          setIsLoadingRooms(false);
          return;
        }
        rData = snap.data();
      } else {
        if (cleanRoomId === 'TEST') {
          rData = { roomId: "TEST", hostName: "キキミミ公式Bot", maxPlayers: 2, players: [{id: "bot", name: "公式Bot", stars: 0, isHost: true, isReady: true, status: "idle"}], difficulty: "hard", roundsToWin: 3, password: "", status: "waiting" };
        } else {
          alert("オフライン/Dummyのため部屋が見つかりません。試験用ID 'TEST' をお使いください。");
          setIsLoadingRooms(false);
          return;
        }
      }

      if (rData.players.length >= rData.maxPlayers) {
        alert("この対戦ルームはすでに満員です。");
        setIsLoadingRooms(false);
        return;
      }

      if (rData.status !== 'waiting') {
        alert("すでにゲームが開始されています。");
        setIsLoadingRooms(false);
        return;
      }

      if (rData.password && rData.password !== pass) {
        const p = prompt("パスワード(4桁数字)を入力してください：");
        if (p === null) {
          setIsLoadingRooms(false);
          return;
        }
        if (p !== rData.password) {
          alert("パスワードが違います。");
          setIsLoadingRooms(false);
          return;
        }
      }

      const newPlayer = {
        id: onlinePlayerId,
        name: onlinePlayerName.trim(),
        stars: 0,
        isHost: false,
        isReady: false,
        status: 'idle',
        icon: accountIcon || 'null'
      };

      const updatedPlayers = [...rData.players, newPlayer];

      if (!isDummy && db) {
        const roomRef = doc(db, 'rooms', cleanRoomId);
        await updateDoc(roomRef, {
          players: updatedPlayers,
          updatedAt: new Date().toISOString()
        });
      }

      setActiveRoomId(cleanRoomId);
      setActiveRoom({ ...rData, players: updatedPlayers });
      setGameState('onlineRoom');
      setOnlineStatusMessage('');

    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingRooms(false);
    }
  };

  const leaveOnlineRoom = async (targetState: 'start' | 'onlineLobby' = 'start') => {
    if (!activeRoomId) {
      setGameState(targetState);
      stopAllAudio();
      return;
    }
    const isHost = activeRoom?.hostId === onlinePlayerId;
    
    try {
      if (!isDummy && db) {
        const roomRef = doc(db, 'rooms', activeRoomId);
        if (isHost || activeRoom?.players.length <= 1) {
          await deleteDoc(roomRef);
        } else {
          const updatedPlayers = activeRoom.players.filter((p: any) => p.id !== onlinePlayerId);
          await updateDoc(roomRef, {
            players: updatedPlayers,
            updatedAt: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActiveRoom(null);
      setActiveRoomId('');
      setGameState(targetState);
      stopAllAudio();
    }
  };

  const toggleReadyOnline = async () => {
    if (!activeRoomId || !activeRoom) return;
    const updatedPlayers = activeRoom.players.map((p: any) => {
      if (p.id === onlinePlayerId) {
        return { ...p, isReady: !p.isReady };
      }
      return p;
    });

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), {
          players: updatedPlayers,
          updatedAt: new Date().toISOString()
        });
      } else {
        setActiveRoom({ ...activeRoom, players: updatedPlayers });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const quickJoinOnline = async () => {
    setIsLoadingRooms(true);
    setOnlineLobbySubMode('quick');
    if (isDummy || !db) {
      setTimeout(() => {
        joinOnlineRoom('TEST');
      }, 1000);
      return;
    }

    try {
      const q = query(
        collection(db, 'rooms'),
        where('status', '==', 'waiting'),
        limit(20)
      );
      const snap = await getDocs(q);
      let foundRoom: any = null;
      
      snap.forEach(docSnap => {
        if (foundRoom) return;
        const d = docSnap.data();
        if (!d.password && d.players.length < d.maxPlayers) {
          foundRoom = d;
        }
      });

      if (foundRoom) {
        await joinOnlineRoom(foundRoom.roomId);
      } else {
        await createOnlineRoom();
      }
    } catch (e) {
      console.error("Quick join failed, creating new:", e);
      await createOnlineRoom();
    }
  };

  const generateProblemData = (mode: 'normal' | 'hard' | 'hell') => {
    const chars = Object.keys(CHARACTERS) as CharKey[];
    const target = chars[Math.floor(Math.random() * chars.length)];

    const whoAll = VOICE_DB.filter(v => v.part === 1);
    const wheAll = VOICE_DB.filter(v => v.part === 2);
    const whyAll = VOICE_DB.filter(v => v.part === 3);
    const whaAll = VOICE_DB.filter(v => v.part === 4);

    const pickForChar = (char: CharKey, exclude?: VoiceData[]) => {
      const who = shuffle(whoAll.filter(v => v.voice.substring(0, 2) === char && (!exclude || v.voice !== exclude[0]?.voice)))[0] || whoAll[0];
      const whe = shuffle(wheAll.filter(v => v.voice.substring(0, 2) === char && (!exclude || v.voice !== exclude[1]?.voice)))[0] || wheAll[0];
      
      if (mode === 'hard' || mode === 'hell') {
        const why = shuffle(whyAll.filter(v => v.voice.substring(0, 2) === char && (!exclude || v.voice !== exclude[2]?.voice)))[0] || whyAll[0];
        const wha = shuffle(whaAll.filter(v => v.voice.substring(0, 2) === char && (!exclude || v.voice !== exclude[3]?.voice)))[0] || whaAll[0];
        return [who, whe, why, wha];
      } else {
        const wha = shuffle(whaAll.filter(v => v.voice.substring(0, 2) === char && (!exclude || v.voice !== exclude[2]?.voice)))[0] || whaAll[0];
        return [who, whe, wha];
      }
    };

    const targetA = pickForChar(target);
    const sampleA = pickForChar(target, targetA);

    const others: Record<string, VoiceData[]> = {};
    const otherCharsFull = chars.filter(c => c !== target);
    const otherCharsToUse = mode === 'hell' 
      ? otherCharsFull 
      : getRandomElements(otherCharsFull, 2);

    otherCharsToUse.forEach(c => {
      others[c] = pickForChar(c);
    });

    const createColOptions = (correct: VoiceData, all: VoiceData[]) => {
      const distractors = getRandomElements(all.filter(v => v.voice !== correct.voice), 4);
      return shuffle([correct, ...distractors]);
    };

    let pOptions: any = {};
    if (mode === 'hard' || mode === 'hell') {
      pOptions = {
        who: createColOptions(targetA[0], whoAll),
        where: createColOptions(targetA[1], wheAll),
        why: createColOptions(targetA[2], whyAll),
        what: createColOptions(targetA[3], whaAll)
      };
    } else {
      pOptions = {
        who: createColOptions(targetA[0], whoAll),
        where: createColOptions(targetA[1], wheAll),
        what: createColOptions(targetA[2], whaAll)
      };
    }

    return {
      targetChar: target,
      targetAnswers: targetA,
      sampleAnswers: sampleA,
      otherCharVoices: others,
      options: pOptions
    };
  };

  const startOnlineGameSequence = async (roundNum: number = 1) => {
    if (!activeRoomId || !activeRoom) return;
    
    const prob = generateProblemData(activeRoom.difficulty);
    const initializedPlayers = activeRoom.players.map((p: any) => ({
      ...p,
      isReady: false,
      status: 'idle'
    }));

    const updatePayload = {
      status: 'sampling',
      currentRound: roundNum,
      currentProblem: prob,
      players: initializedPlayers,
      samplingStartAt: Date.now(),
      countdownStartAt: 0,
      answerState: null,
      updatedAt: new Date().toISOString()
    };

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        setActiveRoom({ ...activeRoom, ...updatePayload });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const markReadyForOnlineRound = async () => {
    if (!activeRoom || !activeRoomId) return;
    setIsReadyForOnlineRound(true);

    const updatedPlayers = activeRoom.players.map((p: any) => {
      if (p.id === onlinePlayerId) {
        return { ...p, isReady: true };
      }
      return p;
    });

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), {
          players: updatedPlayers
        });
      } else {
        setActiveRoom({ ...activeRoom, players: updatedPlayers });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const transitionToCountdown = async () => {
    if (!activeRoomId || !activeRoom) return;
    
    const updatePayload = {
      status: 'ready_countdown',
      countdownStartAt: Date.now(),
      updatedAt: new Date().toISOString()
    };

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        setActiveRoom({ ...activeRoom, ...updatePayload });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const triggerPlayPhase = async () => {
    if (!activeRoomId || !activeRoom) return;
    
    const updatePayload = {
      status: 'playing',
      playingStartAt: Date.now(),
      updatedAt: new Date().toISOString()
    };

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        setActiveRoom({ ...activeRoom, ...updatePayload });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleOnlineRoundTimeout = async () => {
    if (!activeRoomId || !activeRoom) return;
    if (activeRoom.status !== 'playing') return;

    const limitSeconds = activeRoom.difficulty === 'hell' ? 60 : (activeRoom.difficulty === 'hard' ? 45 : 30);

    if (isDummy || !db) {
      const currentPlayers = activeRoom.players.map((p: any) => {
        if (p.status === 'idle') {
          return {
            ...p,
            status: 'timeout',
            submitTime: limitSeconds,
            isCorrectAnswer: false
          };
        }
        return p;
      });

      const evaluated = evaluateOnlineRound(currentPlayers, activeRoom.roundsToWin, activeRoom.currentRound);
      setActiveRoom({
        ...activeRoom,
        players: evaluated.players,
        status: evaluated.nextStatus,
        answerState: evaluated.answerState,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    try {
      const roomRef = doc(db, 'rooms', activeRoomId);
      await runTransaction(db, async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists()) return;

        const rData = roomDoc.data();
        if (rData.status !== 'playing') return;

        const currentPlayers = rData.players.map((p: any) => {
          if (p.status === 'idle') {
            return {
              ...p,
              status: 'timeout',
              submitTime: limitSeconds,
              isCorrectAnswer: false
            };
          }
          return p;
        });

        const evaluated = evaluateOnlineRound(currentPlayers, rData.roundsToWin, rData.currentRound);
        transaction.update(roomRef, {
          players: evaluated.players,
          status: evaluated.nextStatus,
          answerState: evaluated.answerState,
          updatedAt: new Date().toISOString()
        });
      });
    } catch (e) {
      console.error(e);
    }
  };

  const submitOnlineAnswer = async () => {
    if (!activeRoomId || !activeRoom) return;
    if (activeRoom.status !== 'playing') return;

    const isCorrect = 
      selections.who === targetAnswers[0]?.voice &&
      selections.where === targetAnswers[1]?.voice &&
      (gameMode === 'normal' 
        ? selections.what === targetAnswers[2]?.voice
        : selections.why === targetAnswers[2]?.voice && selections.what === targetAnswers[3]?.voice);

    // オンライン対戦で解答完了時のSE再生
    stopAllAudio();
    const se = new Audio(isCorrect ? "assets/se/win3.mp3" : "assets/se/lose3.mp3");
    se.volume = seVolume;
    se.play().catch(e => console.error("SE status change play failed", e));

    if (isDummy || !db) {
      const elapsedSec = Math.round(((Date.now() - activeRoom.playingStartAt) / 1000) * 10) / 10;
      
      const updatedPlayers = activeRoom.players.map((p: any) => {
        if (p.id === onlinePlayerId) {
          return { 
            ...p, 
            status: isCorrect ? 'answered' : 'fault',
            submitTime: elapsedSec,
            isCorrectAnswer: isCorrect
          };
        }
        return p;
      });

      const allDone = updatedPlayers.every((p: any) => p.status !== 'idle');

      let nextRoomState = { 
        ...activeRoom, 
        players: updatedPlayers,
        latestNotification: {
          name: onlinePlayerName || 'プレイヤー',
          action: isCorrect ? 'correct' : 'fault',
          timestamp: Date.now()
        }
      };

      if (allDone) {
        const evaluated = evaluateOnlineRound(updatedPlayers, activeRoom.roundsToWin, activeRoom.currentRound);
        nextRoomState.players = evaluated.players;
        nextRoomState.status = evaluated.nextStatus;
        nextRoomState.answerState = evaluated.answerState;
      }
      
      setActiveRoom(nextRoomState);
      return;
    }

    try {
      const roomRef = doc(db, 'rooms', activeRoomId);

      await runTransaction(db, async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists()) return;

        const rData = roomDoc.data();
        if (rData.status !== 'playing') return;

        const currentPlayers = [...rData.players];
        const myPlayerIndex = currentPlayers.findIndex((p: any) => p.id === onlinePlayerId);
        
        if (myPlayerIndex === -1 || currentPlayers[myPlayerIndex].status !== 'idle') {
          return;
        }

        const elapsedSec = Math.round(((Date.now() - rData.playingStartAt) / 1000) * 10) / 10;
        
        currentPlayers[myPlayerIndex].status = isCorrect ? 'answered' : 'fault';
        currentPlayers[myPlayerIndex].submitTime = elapsedSec;
        currentPlayers[myPlayerIndex].isCorrectAnswer = isCorrect;

        const allDone = currentPlayers.every((p: any) => p.status !== 'idle');
        
        const latestNotification = {
          name: onlinePlayerName,
          action: isCorrect ? 'correct' : 'fault',
          timestamp: Date.now()
        };

        if (allDone) {
          const evaluated = evaluateOnlineRound(currentPlayers, rData.roundsToWin, rData.currentRound);
          transaction.update(roomRef, {
            players: evaluated.players,
            status: evaluated.nextStatus,
            answerState: evaluated.answerState,
            latestNotification,
            updatedAt: new Date().toISOString()
          });
        } else {
          transaction.update(roomRef, {
            players: currentPlayers,
            latestNotification,
            updatedAt: new Date().toISOString()
          });
        }
      });
    } catch (e) {
      console.error(e);
    }
  };

  const nextOnlineRound = async () => {
    if (!activeRoom || !activeRoomId) return;
    const isHost = activeRoom.hostId === onlinePlayerId;
    if (!isHost) return;

    const isGameSet = checkOnlineGameSet(activeRoom.players, activeRoom.roundsToWin, activeRoom.currentRound || 1);

    if (isGameSet) {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), {
          status: 'game_over',
          updatedAt: new Date().toISOString()
        });
      } else {
        setActiveRoom(prev => prev ? { ...prev, status: 'game_over' } : null);
      }
    } else {
      const nextRound = (activeRoom.currentRound || 1) + 1;
      await startOnlineGameSequence(nextRound);
    }
  };

  const handleFinishedOnlineGame = async () => {
    if (!activeRoom || !activeRoomId) return;
    const isHost = activeRoom.hostId === onlinePlayerId;
    if (!isHost) {
      leaveOnlineRoom();
      return;
    }

    const resetPlayers = activeRoom.players.map((p: any) => ({
      ...p,
      stars: 0,
      isReady: p.isHost,
      status: 'idle'
    }));

    const updatePayload = {
      status: 'waiting',
      currentRound: 1,
      players: resetPlayers,
      currentProblem: null,
      answerState: null,
      updatedAt: new Date().toISOString()
    };

    try {
      if (!isDummy && db) {
        await updateDoc(doc(db, 'rooms', activeRoomId), updatePayload);
      } else {
        setActiveRoom({ ...activeRoom, ...updatePayload });
      }
      setGameState('onlineRoom');
    } catch (e) {
      console.error(e);
    }
  };

  const copyRoomUrlToClipboard = () => {
    setIsCopying(true);
    const origin = window.location.origin + window.location.pathname;
    const url = `${origin}?room=${activeRoomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setTimeout(() => setIsCopying(false), 2000);
    });
  };

  const initGame = (
    mode: 'normal' | 'hard' | 'hell' = 'normal', 
    isNextRound = false, 
    isChallengeStart = false
  ) => {
    stopAllAudio();
    setGameMode(mode);
    
    if (isChallengeStart) {
      setIsChallenge(true);
      setCurrentRound(1);
      setChallengeScores([]);
      setHasSubmittedThisGame(false);
    } else if (isNextRound) {
      setCurrentRound(prev => prev + 1);
    } else if (!isChallenge) {
      setIsChallenge(false);
      setCurrentRound(1);
      setChallengeScores([]);
    }
    
    setRepeatCount(0);
    const chars = Object.keys(CHARACTERS) as CharKey[];
    const target = chars[Math.floor(Math.random() * chars.length)];
    setTargetChar(target);

    // Pick target's correct answers
    const whoAll = VOICE_DB.filter(v => v.part === 1);
    const wheAll = VOICE_DB.filter(v => v.part === 2);
    const whyAll = VOICE_DB.filter(v => v.part === 3);
    const whaAll = VOICE_DB.filter(v => v.part === 4);

    const pickForChar = (char: CharKey, exclude?: VoiceData[]) => {
      const who = shuffle(whoAll.filter(v => v.voice.startsWith(char) && (!exclude || v.voice !== exclude[0]?.voice)))[0] || whoAll[0];
      const whe = shuffle(wheAll.filter(v => v.voice.startsWith(char) && (!exclude || v.voice !== exclude[1]?.voice)))[0] || wheAll[0];
      
      if (mode === 'hard' || mode === 'hell') {
        const why = shuffle(whyAll.filter(v => v.voice.startsWith(char) && (!exclude || v.voice !== exclude[2]?.voice)))[0] || whyAll[0];
        const wha = shuffle(whaAll.filter(v => v.voice.startsWith(char) && (!exclude || v.voice !== exclude[3]?.voice)))[0] || whaAll[0];
        return [who, whe, why, wha];
      } else {
        const wha = shuffle(whaAll.filter(v => v.voice.startsWith(char) && (!exclude || v.voice !== exclude[2]?.voice)))[0] || whaAll[0];
        return [who, whe, wha];
      }
    };

    const targetA = pickForChar(target);
    const sampleA = pickForChar(target, targetA);
    setTargetAnswers(targetA);
    setSampleAnswers(sampleA);

    // Pick other characters' voices (distractors in audio)
    const others: Record<string, VoiceData[]> = {};
    const otherCharsFull = chars.filter(c => c !== target);
    const otherCharsToUse = mode === 'hell' 
      ? otherCharsFull 
      : getRandomElements(otherCharsFull, 2);

    otherCharsToUse.forEach(c => {
      others[c] = pickForChar(c);
    });
    setOtherCharVoices(others);

    // Create Options: 1 correct + 4 random distractor per column
    const createColOptions = (correct: VoiceData, all: VoiceData[]) => {
      const distractors = getRandomElements(all.filter(v => v.voice !== correct.voice), 4);
      return shuffle([correct, ...distractors]);
    };

    if (mode === 'hard' || mode === 'hell') {
      setOptions({
        who: createColOptions(targetA[0], whoAll),
        where: createColOptions(targetA[1], wheAll),
        why: createColOptions(targetA[2], whyAll),
        what: createColOptions(targetA[3], whaAll)
      });
      setSelections({ who: null, where: null, why: null, what: null });
    } else {
      setOptions({
        who: createColOptions(targetA[0], whoAll),
        where: createColOptions(targetA[1], wheAll),
        what: createColOptions(targetA[2], whaAll)
      });
      setSelections({ who: null, where: null, why: null, what: null });
    }

    setTimeLeft(mode === 'hell' ? 60 : (mode === 'hard' ? 45 : 30));
    setIsMobileStep(0);
    setHasStarted(false);
    setGameState('reveal');
  };

  const startMainGame = () => {
    stopAllAudio(); // 確実に止めてから開始
    setGameState('main');
    setHasStarted(false);
  };

  const handleStartPlay = () => {
    setHasStarted(true);
    playSimultaneous();
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          handleDecide(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleDecide = (isTimeout = false) => {
    if (timerRef.current) clearInterval(timerRef.current);
    
    let isCorrect = false;
    if (gameMode === 'hard' || gameMode === 'hell') {
      isCorrect = 
        selections.who === targetAnswers[0]?.card &&
        selections.where === targetAnswers[1]?.card &&
        selections.why === targetAnswers[2]?.card &&
        selections.what === targetAnswers[3]?.card;
    } else {
      isCorrect = 
        selections.who === targetAnswers[0]?.card &&
        selections.where === targetAnswers[1]?.card &&
        selections.what === targetAnswers[2]?.card;
    }

    // スコア計算
    let roundScore = 0;
    if (isCorrect && !isTimeout) {
      const initialLimit = gameMode === 'hell' ? 60 : (gameMode === 'hard' ? 45 : 30);
      const secondsElapsed = initialLimit - timeLeft;
      const computed = 10000 - (secondsElapsed * 100) - (repeatCount * 1000);
      roundScore = Math.max(0, computed);
    }
    
    setChallengeScores(prev => [...prev, roundScore]);

    // 統計アップデート
    const kikiStats = getMyStats();
    if (targetChar) {
      kikiStats.asked[targetChar] = (kikiStats.asked[targetChar] || 0) + 1;
      if (isCorrect) {
        kikiStats.correct[targetChar] = (kikiStats.correct[targetChar] || 0) + 1;
      }
    }

    let justClearedMode: 'normal' | 'hard' | 'hell' | undefined = undefined;
    let justPlayedChallengeMode: 'normal' | 'hard' | 'hell' | undefined = undefined;

    if (isChallenge) {
      if (currentRound === 3) {
        const finalScore = [...challengeScores, roundScore].reduce((sum, s) => sum + s, 0);
        if (gameMode === 'normal') {
          kikiStats.challenge_normal_play_count += 1;
          justPlayedChallengeMode = 'normal';
          if (finalScore > kikiStats.challenge_normal_high_score) {
            kikiStats.challenge_normal_high_score = finalScore;
          }
        } else if (gameMode === 'hard') {
          kikiStats.challenge_hard_play_count += 1;
          justPlayedChallengeMode = 'hard';
          if (finalScore > kikiStats.challenge_hard_high_score) {
            kikiStats.challenge_hard_high_score = finalScore;
          }
        } else if (gameMode === 'hell') {
          kikiStats.challenge_hell_play_count += 1;
          justPlayedChallengeMode = 'hell';
          if (finalScore > kikiStats.challenge_hell_high_score) {
            kikiStats.challenge_hell_high_score = finalScore;
          }
        }
      }
    } else {
      if (isCorrect) {
        if (gameMode === 'normal') {
          kikiStats.normal_play_count += 1;
          justClearedMode = 'normal';
        } else if (gameMode === 'hard') {
          kikiStats.hard_play_count += 1;
          justClearedMode = 'hard';
        } else if (gameMode === 'hell') {
          kikiStats.hell_play_count += 1;
          justClearedMode = 'hell';
        }
      }
    }
    saveMyStats(kikiStats);
    checkNewIconUnlock(kikiStats, justClearedMode, justPlayedChallengeMode);
    
    // タイムアウトしても正解を選んでいれば勝ち
    setWin(isCorrect);
    setGameState('result');
    // Play correct answer voice at the end
    stopAllAudio();

    const se = new Audio(isCorrect ? "assets/se/win.mp3" : "assets/se/lose.mp3");
    se.volume = seVolume;
    se.play().catch(e => console.error("SE play failed:", e));

    playCharSequence(targetAnswers);
  };

  const handleSelectIcon = async (iconKey: string | null) => {
    setAccountIcon(iconKey);
    if (iconKey) {
      localStorage.setItem('kikimimi_account_icon', iconKey);
    } else {
      localStorage.removeItem('kikimimi_account_icon');
    }

    if (isAccountRegistered && db && !isDummy) {
      try {
        const cleanName = onlinePlayerName.trim().toLowerCase();
        const userRef = doc(db, 'kikimimi_usernames', cleanName);
        await updateDoc(userRef, {
          icon: iconKey || 'null'
        });
      } catch (err) {
        console.error('Failed to update icon in Firestore:', err);
      }
    }
  };

  const handleRegisterUsername = async (desiredName: string) => {
    setRegisterError('');
    setRegisterSuccess('');
    
    const clean = desiredName.trim();
    if (!clean) {
      setRegisterError('名前を入力してください。');
      return;
    }
    if (clean.length > 8) {
      setRegisterError('名前は8文字以内で入力してください。');
      return;
    }

    const normalized = clean.toLowerCase();
    const banned = ['admin', 'gamemaster', 'gm', 'システム管理者', '管理者', '管理人', 'ｓｙｓｔｅｍ', 'ａｄｍｉｎ', 'ｇｍ'];
    if (banned.some(b => normalized.includes(b))) {
      setRegisterError('このユーザー名は使用できません。');
      return;
    }

    setIsRegistering(true);

    try {
      if (db && !isDummy) {
        const userRef = doc(db, 'kikimimi_usernames', normalized);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          setRegisterError('このユーザー名はすでに使用されています。');
          setIsRegistering(false);
          return;
        }

        await setDoc(userRef, {
          uid: onlinePlayerId,
          displayName: clean,
          icon: accountIcon || 'null',
          registeredAt: new Date().toISOString()
        });
      }

      localStorage.setItem('kikimimi_online_name', clean);
      localStorage.setItem('kikimimi_account_registered', 'true');
      setIsAccountRegistered(true);
      setOnlinePlayerName(clean);
      setPlayerName(clean);
      setRegisterSuccess('ユーザー名を登録しました！');
    } catch (err) {
      console.error('Username registration error:', err);
      setRegisterError('登録エラーが発生しました。時間を置いてお試しください。');
    } finally {
      setIsRegistering(false);
    }
  };

  const getCharacterAccuracyStats = () => {
    const stats = getMyStats();
    const chars = Object.keys(CHARACTERS) as CharKey[];
    
    let highestChar: CharKey | null = null;
    let highestRate = -1;
    let lowestChar: CharKey | null = null;
    let lowestRate = 101;
    
    let hasData = false;
    
    chars.forEach(char => {
      const asked = stats.asked[char] || 0;
      const correct = stats.correct[char] || 0;
      if (asked > 0) {
        hasData = true;
        const rate = (correct / asked) * 100;
        if (rate > highestRate) {
          highestRate = rate;
          highestChar = char;
        }
        if (rate < lowestRate) {
          lowestRate = rate;
          lowestChar = char;
        }
      }
    });
    
    return {
      hasData,
      highest: highestChar ? {
        name: CHARACTERS[highestChar].name,
        color: CHARACTERS[highestChar].color,
        image: CHARACTERS[highestChar].image,
        rate: Math.round(highestRate)
      } : null,
      lowest: lowestChar ? {
        name: CHARACTERS[lowestChar].name,
        color: CHARACTERS[lowestChar].color,
        image: CHARACTERS[lowestChar].image,
        rate: Math.round(lowestRate)
      } : null
    };
  };

  const fetchLeaderboard = async (mode: 'normal' | 'hard' | 'hell') => {
    setIsLoadingLeaderboard(true);
    try {
      const data = await getLeaderboard(mode);
      setLeaderboardEntries(data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingLeaderboard(false);
    }
  };

  const handleScoreSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanName = playerName.trim();
    if (!cleanName || cleanName.length > 8) return;
    setIsSubmitting(true);
    try {
      const totalScore = challengeScores.reduce((sum, s) => sum + s, 0);
      await submitScore(cleanName, totalScore, gameMode);
      setHasSubmittedThisGame(true);
      setLeaderboardMode(gameMode);
      await fetchLeaderboard(gameMode);
      setGameState('leaderboard');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRepeatPlay = () => {
    if (isPlaying || !hasStarted) return;
    setRepeatCount(prev => prev + 1);
    playSimultaneous();
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    const checkOrientation = () => {
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isPort = window.innerHeight > window.innerWidth;
      setIsPortrait(isTouch && isPort);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    window.addEventListener('resize', checkOrientation);
    checkOrientation();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('resize', checkOrientation);
    };
  }, []);

  // UI Renders
  const Card = ({ data, selected, onSelect, icon: Icon }: { key?: any, data: VoiceData, selected: boolean, onSelect: () => void, icon: any }) => (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onSelect}
      className={`relative w-full p-4 mb-2 text-left border-4 transition-colors rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] ${
        selected 
          ? 'bg-yellow-300 border-black ring-4 ring-yellow-100 z-10' 
          : 'bg-white border-black hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="bg-gray-100 p-2 rounded-lg border border-gray-200">
          <Icon size={20} className="text-gray-600" />
        </div>
        <span className="font-bold text-gray-800 leading-tight">{data.card}</span>
      </div>
    </motion.button>
  );

  return (
    <div className="min-h-screen bg-[#F0F2F5] font-sans text-black selection:bg-yellow-200 relative">
      {/* Floating game event notification toast */}
      <AnimatePresence>
        {localToast && (
          <motion.div
            key={localToast.key}
            initial={{ opacity: 0, y: -45, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            transition={{ duration: 0.25 }}
            className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-6 py-3 border-4 border-black rounded-xl font-black text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] max-w-[90vw] whitespace-normal ${
              localToast.message.includes('正解') ? 'bg-emerald-100 text-emerald-950' : 'bg-red-100 text-red-950'
            }`}
          >
            📢 {localToast.message}
          </motion.div>
        )}
      </AnimatePresence>

      {isPortrait && (
        <div className="fixed inset-0 z-[9999] bg-slate-900 text-white flex flex-col items-center justify-center p-6 text-center">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-md flex flex-col items-center gap-6"
          >
            <div className="relative w-24 h-24 flex items-center justify-center">
              <motion.div
                animate={{ rotate: [0, -90, -90, 0] }}
                transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
                className="w-12 h-20 border-4 border-white rounded-lg relative"
              >
                <div className="absolute top-1 left-1/2 -translate-x-1/2 w-4 h-1 bg-white rounded-full" />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white rounded-full" />
              </motion.div>
              <motion.div
                animate={{ x: [-10, 10, -10], opacity: [0, 1, 0] }}
                transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
                className="absolute text-pink-400 font-bold text-lg"
              >
                ➔
              </motion.div>
            </div>
            <div>
              <h1 className="text-2xl font-black mb-3 text-pink-400">画面を横向きにしてください</h1>
              <p className="text-sm text-slate-300 leading-relaxed font-sans">
                このゲームはスマホの横画面専用です。<br />
                端末の「画面回転ロック」を解除し、<br />
                スマートフォンを横向きにしてお楽しみください。
              </p>
            </div>
          </motion.div>
        </div>
      )}
      {/* 画面右上のコントロールグループ */}
      <div className="fixed top-4 right-4 z-40 flex items-center gap-2">
        {(gameState === 'start' || gameState === 'reveal') && (
          <>
            {/* ランキングボタン */}
            <button
              onClick={async () => {
                setLeaderboardMode('normal');
                await fetchLeaderboard('normal');
                setGameState('leaderboard');
              }}
              className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-gray-50 border-[3px] border-black font-black text-xs shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all text-amber-600 rounded-lg cursor-pointer"
              title="ランキングを見る"
            >
              <Trophy size={14} className="fill-yellow-400 text-yellow-500" />
              <span>ランキング</span>
            </button>
          </>
        )}

        {/* フルスクリーンボタン（アイコンのみ、アカウントボタンの左隣に常時表示） */}
        <button
          onClick={toggleFullscreen}
          className="p-2 bg-white border-[3px] border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 active:scale-95 transition-all rounded-full flex items-center justify-center text-black cursor-pointer"
          title={isFullscreen ? "フルスクリーン解除" : "フルスクリーンにする"}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>

        {/* アカウントボタン */}
        <button 
          onClick={() => setShowAccountModal(true)}
          className="p-1.5 bg-white border-[3px] border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 active:scale-95 transition-all rounded-full cursor-pointer flex items-center justify-center overflow-hidden w-[36px] h-[36px]"
          title="アカウント情報 & スタッツ"
        >
          <div className="flex items-center justify-center w-full h-full bg-gray-100 rounded-full text-black">
            <User size={18} />
          </div>
        </button>

        {/* 設定ボタン */}
        <button 
          onClick={() => setShowSettings(true)}
          className="p-2 bg-white border-[3px] border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 active:scale-95 transition-all rounded-full cursor-pointer"
          title="設定"
        >
          <Settings size={18} />
        </button>
      </div>
      <AnimatePresence mode="wait">
        {showSettings && (
          <motion.div
            key="settings"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md bg-white border-4 border-black p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] relative"
            >
              <button 
                onClick={() => { setShowSettings(false); setShowCredits(false); }} 
                className="absolute top-4 right-4 p-2 hover:bg-gray-100 rounded-full border-2 border-transparent hover:border-black transition-all"
              >
                <X size={24} />
              </button>
              
              {!showCredits ? (
                <>
                  <h2 className="text-3xl font-black mb-8 flex items-center gap-2 italic">
                    <Settings size={32} /> SETTINGS
                  </h2>

                  <div className="space-y-8 mb-10">
                    <div className="space-y-3">
                      <div className="flex justify-between font-black uppercase tracking-tight">
                        <span>BGM Volume</span>
                        <span className="text-yellow-500">{Math.round(bgmVolume * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <Volume2 size={20} className="text-gray-400" />
                        <input 
                          type="range" min="0" max="1" step="0.01" value={bgmVolume} 
                          onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                          className="flex-1 accent-black h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex justify-between font-black uppercase tracking-tight">
                        <span>SE / VOICE Volume</span>
                        <span className="text-yellow-500">{Math.round(seVolume * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <Volume2 size={20} className="text-gray-400" />
                        <input 
                          type="range" min="0" max="1" step="0.01" value={seVolume} 
                          onChange={(e) => setSeVolume(parseFloat(e.target.value))}
                          className="flex-1 accent-black h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    <button
                      onClick={() => {
                        setGameState('start');
                        setShowSettings(false);
                        setShowCredits(false);
                        stopAllAudio();
                      }}
                      className="w-full p-4 border-4 border-black font-black text-xl hover:bg-gray-50 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-0 hover:translate-x-[4px] hover:translate-y-[4px] transition-all bg-yellow-400"
                    >
                      タイトルへ戻る
                    </button>
                    <button
                      onClick={() => setShowCredits(true)}
                      className="w-full p-4 border-4 border-black font-black text-xl hover:bg-gray-50 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-0 hover:translate-x-[4px] hover:translate-y-[4px] transition-all bg-white"
                    >
                      CREDITS
                    </button>
                    <button
                      onClick={() => { setShowSettings(false); setShowCredits(false); }}
                      className="w-full p-4 bg-black text-white font-black text-xl hover:bg-gray-800 shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)]"
                    >
                      閉じる
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="text-3xl font-black mb-6 italic">
                    CREDITS
                  </h2>
                  <div className="bg-gray-50 p-5 border-4 border-black rounded-xl mb-8 text-left whitespace-pre-line font-bold leading-relaxed text-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    {`◆音声
浦和のお姉さん
VOICEVOX:春日部つむぎ様

富良野のお兄さん
VOICEVOX:玄野武宏(CV:ガロ)様

アキバのメイドさん
VOICEVOX:猫使ビィ様

北谷町の漁師
VOICEVOX:麒ケ島宗麟様

◆原案・制作
shun`}
                  </div>
                  <button
                    onClick={() => setShowCredits(false)}
                    className="w-full p-4 bg-black text-white font-black text-xl hover:bg-gray-800 shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)]"
                  >
                    戻る
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}

        {showAccountModal && (
          <motion.div
            key="accountModal"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-xl bg-white border-4 border-black p-6 sm:p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] relative max-h-[85vh] overflow-y-auto"
            >
              <button 
                onClick={() => { setShowAccountModal(false); setRegisterError(''); setRegisterSuccess(''); }} 
                className="absolute top-4 right-4 p-2 hover:bg-gray-100 rounded-full border-2 border-transparent hover:border-black transition-all cursor-pointer text-black"
              >
                <X size={24} />
              </button>

              {/* 1. ユーザー情報 & ユーザー名登録 */}
              <div className="mb-6 bg-amber-50 border-4 border-black rounded-xl p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left">
                <h3 className="font-black text-sm text-amber-900 mb-2 flex items-center gap-1.5 uppercase tracking-wider">
                  👤 アカウント情報
                </h3>
                
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  {/* アバター表示 */}
                  <div className="relative">
                    <div className="w-16 h-16 border-4 border-black rounded-full overflow-hidden bg-white flex items-center justify-center shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                      {accountIcon ? (
                        <img 
                          src={`assets/img/${accountIcon}_265.png`} 
                          alt="avatar" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <User size={30} className="text-gray-400" />
                      )}
                    </div>
                  </div>

                  <div className="flex-1 w-full">
                    {isAccountRegistered ? (
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xl font-black text-black">{onlinePlayerName}</span>
                          <span className="bg-green-100 text-green-800 text-[10px] font-black px-2 py-0.5 rounded-full border border-green-300">
                            登録済み
                          </span>
                        </div>
                        <p className="text-xs font-bold text-gray-500 mt-1">※ユーザー名は固定されています</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input 
                            type="text"
                            maxLength={8}
                            placeholder="ユーザー名(最大8字)"
                            defaultValue={onlinePlayerName.startsWith('guest') ? '' : onlinePlayerName}
                            id="reg_username_input"
                            className="bg-white border-2 border-black px-3 py-1.5 font-bold rounded-lg text-sm text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:ring-2 focus:ring-yellow-400 flex-1"
                          />
                          <button
                            onClick={() => {
                              const input = document.getElementById('reg_username_input') as HTMLInputElement;
                              if (input) {
                                handleRegisterUsername(input.value);
                              }
                            }}
                            disabled={isRegistering}
                            className="px-4 py-1.5 bg-yellow-400 hover:bg-yellow-300 disabled:bg-gray-200 border-2 border-black rounded-lg text-sm font-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none transition-all cursor-pointer text-black"
                          >
                            {isRegistering ? '登録中...' : '登録決定'}
                          </button>
                        </div>
                        <p className="text-[11px] font-extrabold text-red-600 leading-tight">
                          ※ユーザー名を決めるとランキングに載せることができます。一度決めると変更できません。
                        </p>
                      </div>
                    )}

                    {registerError && (
                      <div className="text-xs font-black text-red-600 mt-2 bg-red-50 border border-red-200 p-1.5 rounded-lg">
                        ⚠️ {registerError}
                      </div>
                    )}
                    {registerSuccess && (
                      <div className="text-xs font-black text-green-600 mt-2 bg-green-50 border border-green-200 p-1.5 rounded-lg">
                        🎉 {registerSuccess}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 2. アイコン(アバター)選択 */}
              <div className="mb-6 bg-sky-50 border-4 border-black rounded-xl p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left">
                <h3 className="font-black text-sm text-sky-950 mb-3 flex items-center justify-between">
                  <span>🎭 アバター選択</span>
                  <button 
                    onClick={() => handleSelectIcon(null)}
                    className="text-[10px] font-black underline bg-white px-2 py-0.5 border border-black rounded shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] cursor-pointer hover:bg-gray-50 text-black animate-none"
                  >
                    リセット
                  </button>
                </h3>
                
                <div className="grid grid-cols-4 gap-3">
                  {(() => {
                    const currentUnlocked: string[] = JSON.parse(localStorage.getItem('kikimimi_unlocked_icons') || '[]');
                    return (['ta', 'ka', 'ne', 'so'] as const).map(charKey => {
                      const charInfo = CHARACTERS[charKey];
                      const isSelected = accountIcon === charKey;
                      const isUnlocked = currentUnlocked.includes(charKey);

                      if (isUnlocked) {
                        return (
                          <button
                            key={charKey}
                            onClick={() => handleSelectIcon(charKey)}
                            className={`p-1.5 rounded-xl border-2 transition-all cursor-pointer relative ${
                              isSelected 
                                ? 'bg-yellow-300 border-black ring-4 ring-yellow-400 shadow-none' 
                                : 'bg-white border-gray-300 hover:border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                            }`}
                            title={charInfo.name}
                          >
                            <div className="aspect-square rounded-lg overflow-hidden border border-black bg-gray-50">
                              <img 
                                src={charInfo.image} 
                                alt={charInfo.name} 
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          </button>
                        );
                      } else {
                        return (
                          <div
                            key={charKey}
                            className="p-1.5 rounded-xl border border-dashed border-gray-300 bg-gray-100 flex items-center justify-center relative aspect-square"
                            title="未解放アバター"
                          >
                            <span className="text-gray-400 font-black text-lg">❓</span>
                          </div>
                        );
                      }
                    });
                  })()}
                </div>
              </div>

              {/* 3. 統計スタッツ & 自己ベスト */}
              <div className="mb-6 bg-emerald-50 border-4 border-black rounded-xl p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left">
                <h3 className="font-black text-sm text-emerald-950 mb-3 flex items-center gap-1.5 uppercase tracking-wider">
                  📈 統計スタッツ (自己ベスト詳細)
                </h3>

                {(() => {
                  const stats = getMyStats();
                  const accuracy = getCharacterAccuracyStats();
                  return (
                    <div className="space-y-4">
                      {/* 通常 / チャレンジ プレイ実績 */}
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-white border-2 border-black p-2 rounded-lg">
                          <span className="font-black block text-emerald-800 text-[10px] uppercase tracking-tighter mb-1">⚡ 通常プレイ回数</span>
                          <div className="space-y-0.5 font-bold text-black text-left">
                            <div>NORMAL: <span className="font-extrabold">{stats.normal_play_count}</span> 回</div>
                            <div>HARD: <span className="font-extrabold">{stats.hard_play_count}</span> 回</div>
                            <div>HELL: <span className="font-extrabold">{stats.hell_play_count}</span> 回</div>
                          </div>
                        </div>
                        <div className="bg-white border-2 border-black p-2 rounded-lg">
                          <span className="font-black block text-indigo-800 text-[10px] uppercase tracking-tighter mb-1">🔥 CHALLENGE プレイ</span>
                          <div className="space-y-0.5 text-[11px] font-bold text-black text-left">
                            <div>NORMAL: <span className="font-extrabold">{stats.challenge_normal_play_count}</span>回 / <span className="font-extrabold text-amber-600">{stats.challenge_normal_high_score.toLocaleString()}</span>点</div>
                            <div>HARD: <span className="font-extrabold">{stats.challenge_hard_play_count}</span>回 / <span className="font-extrabold text-amber-600">{stats.challenge_hard_high_score.toLocaleString()}</span>点</div>
                            <div>HELL: <span className="font-extrabold">{stats.challenge_hell_play_count}</span>回 / <span className="font-extrabold text-amber-600">{stats.challenge_hell_high_score.toLocaleString()}</span>点</div>
                          </div>
                        </div>
                      </div>

                      {/* オンライン実績 */}
                      <div className="bg-white border-2 border-black p-2 rounded-lg text-xs">
                        <span className="font-black block text-pink-800 text-[10px] uppercase tracking-tighter mb-1 font-extrabold">🌐 オンライン対戦実績</span>
                        <div className="grid grid-cols-3 gap-2 font-bold text-black">
                          <div>
                            <span className="block text-[9px] text-gray-500">二人対戦</span>
                            <span>{stats.online_2p_play_count}戦 {stats.online_2p_win_count}勝</span>
                            <span className="block text-[10px] text-pink-600 font-extrabold">
                              ({stats.online_2p_play_count > 0 ? Math.round((stats.online_2p_win_count / stats.online_2p_play_count) * 100) : 0}%)
                            </span>
                          </div>
                          <div>
                            <span className="block text-[9px] text-gray-500">三人対戦</span>
                            <span>{stats.online_3p_play_count}戦 {stats.online_3p_win_count}勝</span>
                            <span className="block text-[10px] text-pink-600 font-extrabold">
                              ({stats.online_3p_play_count > 0 ? Math.round((stats.online_3p_win_count / stats.online_3p_play_count) * 100) : 0}%)
                            </span>
                          </div>
                          <div>
                            <span className="block text-[9px] text-gray-500">四人対戦</span>
                            <span>{stats.online_4p_play_count}戦 {stats.online_4p_win_count}勝</span>
                            <span className="block text-[10px] text-pink-600 font-extrabold">
                              ({stats.online_4p_play_count > 0 ? Math.round((stats.online_4p_win_count / stats.online_4p_play_count) * 100) : 0}%)
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* キャラクター正解率 統計 */}
                      <div className="bg-white border-2 border-black p-3 rounded-lg text-xs text-black">
                        <span className="font-black block text-indigo-900 text-[10px] uppercase tracking-tighter mb-2 font-extrabold">🎯 キャラクター別得意・不得意</span>
                        
                        {accuracy.hasData ? (
                          <div className="grid grid-cols-2 gap-4 text-left">
                            {accuracy.highest && (
                              <div className="flex items-center gap-2 border-r border-gray-100 pr-2">
                                <div className="w-10 h-10 rounded-full border border-black overflow-hidden bg-gray-50 shrink-0">
                                  <img src={accuracy.highest.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                </div>
                                <div className="text-left">
                                  <span className="block text-[9px] text-emerald-600 font-black">👍 得意</span>
                                  <span className="font-extrabold block text-xs leading-none mt-0.5">{accuracy.highest.name}</span>
                                  <span className="text-sm font-black text-emerald-600">{accuracy.highest.rate}%</span>
                                </div>
                              </div>
                            )}
                            {accuracy.lowest && (
                              <div className="flex items-center gap-2">
                                <div className="w-10 h-10 rounded-full border border-black overflow-hidden bg-gray-50 shrink-0">
                                  <img src={accuracy.lowest.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                </div>
                                <div className="text-left">
                                  <span className="block text-[9px] text-red-600 font-black">👎 不得意</span>
                                  <span className="font-extrabold block text-xs leading-none mt-0.5">{accuracy.lowest.name}</span>
                                  <span className="text-sm font-black text-red-600">{accuracy.lowest.rate}%</span>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-[11px] font-bold text-gray-400 text-center py-2">
                            分析に十分なプレイデータがありません。<br />ソロモード、チャレンジ、オンライン対戦をプレイすると表示されます！
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="flex justify-end pt-2 border-t border-gray-100">
                <button
                  onClick={() => { setShowAccountModal(false); setRegisterError(''); setRegisterSuccess(''); }}
                  className="px-8 py-3 bg-black hover:bg-gray-800 text-white font-black text-lg shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)] transition-colors rounded-xl cursor-pointer"
                >
                  閉じる
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {unlockedIconInfo && (
          <motion.div
            key="unlockedIconModal"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-sm bg-white border-4 border-black p-6 sm:p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] relative text-center"
            >
              <div className="flex flex-col items-center">
                <div className="p-3 bg-yellow-400 border-2 border-black rounded-full mb-4 animate-bounce">
                  <span className="text-xl">✨</span>
                </div>
                
                <h2 className="text-xl sm:text-2xl font-black text-black mb-1">
                  新たなアイコンを獲得しました！
                </h2>
                <p className="text-sm font-bold text-gray-500 mb-6">
                  アカウントから使用できます
                </p>

                {/* 解放されたアイコン */}
                <div className="w-28 h-28 border-4 border-black rounded-full overflow-hidden bg-white shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mb-6 flex items-center justify-center">
                  <img 
                    src={unlockedIconInfo.image} 
                    alt={unlockedIconInfo.name} 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
                
                <button
                  onClick={() => setUnlockedIconInfo(null)}
                  className="px-8 py-3 bg-black hover:bg-gray-800 text-white font-black text-lg shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)] transition-colors rounded-xl cursor-pointer"
                >
                  確認
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {gameState === 'start' && (
          <motion.div 
            key="start"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center min-h-screen py-4 px-6 text-center max-w-4xl mx-auto"
          >
            <motion.div 
               initial={{ y: -20, scale: 0.95 }} animate={{ y: 0, scale: 1 }}
               className="mb-4 max-w-full px-4"
            >
              <img 
                src="assets/img/title.png" 
                alt="キキミミ！ 聖徳太子風 聴き取りゲーム" 
                className="max-h-[16vh] md:max-h-[20vh] w-auto h-auto object-contain mx-auto"
                referrerPolicy="no-referrer"
              />
            </motion.div>

            {/* モード選択エリア */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl mb-4">
              
              {/* 通常練習モード */}
              <div className="bg-white border-4 border-black p-5 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-left flex flex-col justify-between">
                <div>
                  <h3 className="text-xl font-black mb-3 pb-1 border-b-2 border-black flex items-center gap-2">
                    <Sliders size={20} /> 通常プレイ <span className="text-xs text-gray-500 font-bold">練習・1ラウンド</span>
                  </h3>
                  <p className="text-sm font-bold text-gray-600 mb-4">
                    声を聴き取るトレーニング！いつでも気軽に1ゲームだけで遊べるモードです。
                  </p>
                </div>
                <div className="space-y-3">
                  <button
                    onClick={() => initGame('normal')}
                    className="w-full py-3 bg-yellow-400 hover:bg-yellow-300 border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>NORMAL</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                  <button
                    onClick={() => initGame('hard')}
                    className="w-full py-3 bg-purple-500 hover:bg-purple-400 text-white border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>HARD</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                  <button
                    onClick={() => initGame('hell')}
                    className="w-full py-3 bg-red-600 hover:bg-red-500 text-white border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>HELL</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                </div>
              </div>
              
              {/* チャレンジモード */}
              <div className="bg-gradient-to-br from-amber-50 to-orange-50 border-4 border-black p-5 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-left flex flex-col justify-between relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-yellow-400 text-xs font-black px-3 py-1 border-b-2 border-l-2 border-black rotate-12 translate-x-2 translate-y-1">
                  RANKING
                </div>
                <div>
                  <h3 className="text-xl font-black mb-3 pb-1 border-b-2 border-black flex items-center gap-2 text-amber-800">
                    <Crown size={20} className="text-amber-600 fill-amber-500 animate-pulse" /> CHALLENGE <span className="text-xs text-amber-700 font-bold">3ラウンドで勝負！</span>
                  </h3>
                  <p className="text-sm font-bold text-amber-950/70 mb-4">
                    3問連続プレイで合計スコアを競え！早い回答で高得点。聞き直しで減点ありのガチ勝負！
                  </p>
                </div>
                <div className="space-y-3">
                  <button
                     onClick={() => initGame('normal', false, true)}
                     className="w-full py-3 bg-yellow-400 hover:bg-yellow-300 border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>NORMAL CHALLENGE</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                  <button
                    onClick={() => initGame('hard', false, true)}
                    className="w-full py-3 bg-purple-500 hover:bg-purple-400 text-white border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>HARD CHALLENGE</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                  <button
                    onClick={() => initGame('hell', false, true)}
                    className="w-full py-3 bg-red-600 hover:bg-red-500 text-white border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-left pl-4 flex items-center justify-between cursor-pointer"
                  >
                    <span>HELL CHALLENGE</span>
                    <ChevronRight size={18} className="mr-2" />
                  </button>
                </div>
              </div>

              {/* オンライン対戦モード */}
              <div className="md:col-span-2 bg-gradient-to-r from-blue-50 to-indigo-50 border-4 border-black p-5 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-left flex flex-col md:flex-row justify-between items-center gap-6">
                <div className="flex-1">
                  <h3 className="text-xl font-black mb-2 pb-1 border-b-2 border-black flex items-center gap-2 text-indigo-900">
                    <Users size={20} className="text-indigo-600 animate-bounce" /> オンライン対戦 <span className="text-xs bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded-full font-black ml-1 uppercase">New!</span>
                  </h3>
                  <p className="text-sm font-bold text-indigo-950/70">
                    友達や全国のプレイヤーと同時リアルタイム対戦！<br/>
                    聞き取りのスピード＆正確性をアトミックに競う2〜4人対戦ゲームです。
                  </p>
                </div>
                <div className="w-full md:w-auto min-w-[240px] flex flex-col gap-2">
                  <div className="flex items-center gap-2 bg-white px-3 py-2 border-2 border-black rounded-lg">
                    <User size={16} />
                    <input 
                      type="text" 
                      value={onlinePlayerName}
                      onChange={(e) => saveOnlinePlayerName(e.target.value)}
                      placeholder="ニックネーム"
                      maxLength={8}
                      className="text-xs font-bold outline-none w-full bg-transparent"
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (!onlinePlayerName.trim()) {
                        alert("ニックネームを入力してください。");
                        return;
                      }
                      setOnlineLobbySubMode('options');
                      setGameState('onlineLobby');
                      refreshAvailableRooms();
                    }}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white border-2 border-black font-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all rounded-lg active:scale-95 text-center flex items-center justify-center gap-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none cursor-pointer"
                  >
                    <span>オンライン対戦へ！</span>
                    <ArrowRight size={18} />
                  </button>
                </div>
              </div>

            </div>
          </motion.div>
        )}

        {/* ========================================================================= */}
        {/* ONLINE MULTIPLAYER LOBBY SCREEN                                          */}
        {/* ========================================================================= */}
        {gameState === 'onlineLobby' && (
          <motion.div 
            key="onlineLobby"
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            className="max-w-4xl mx-auto py-8 px-4 min-h-screen flex flex-col justify-start"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-4 mb-8 bg-white p-5 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] rounded-2xl">
              <div className="flex items-center gap-3">
                <Users className="text-indigo-600 animate-pulse" size={32} />
                <div>
                  <h1 className="text-2xl font-black">対戦ルームロビー</h1>
                  <div className="flex items-center gap-1.5 mt-1 text-slate-700">
                    <span className="text-xs font-bold text-gray-500">プレイヤー:</span>
                    <div className="w-[18px] h-[18px] rounded-full border border-black overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
                      {accountIcon && accountIcon !== 'null' ? (
                        <img 
                          src={`assets/img/${accountIcon}_265.png`} 
                          alt="avatar" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <User size={10} className="text-gray-400" />
                      )}
                    </div>
                    <span className="text-xs font-black text-indigo-700 underline">{onlinePlayerName}</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={leaveOnlineRoom}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 border-2 border-black font-extrabold text-sm shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all rounded-lg cursor-pointer"
              >
                タイトルへ戻る
              </button>
            </div>

            {/* SubMode Routing */}
            {onlineLobbySubMode === 'options' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full mb-8">
                {/* 1. Create Room */}
                <button 
                  onClick={() => setOnlineLobbySubMode('create')}
                  className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all text-left flex flex-col justify-between cursor-pointer min-h-[220px]"
                >
                  <div>
                    <div className="mb-4 inline-block bg-yellow-300 p-3 rounded-xl border-2 border-black">
                      <PlusCircle size={24} />
                    </div>
                    <h3 className="text-lg font-black mb-2">対戦ルームを作成</h3>
                    <p className="text-[11px] font-bold text-gray-500 leading-relaxed">試合数やレベルを指定して、自分自身がホストとなって対戦ルームを作成します。</p>
                  </div>
                  <span className="font-black text-indigo-600 text-xs mt-4 flex items-center gap-1">作成画面へ <ArrowRight size={12} /></span>
                </button>

                {/* 2. Join Room */}
                <button 
                  onClick={() => {
                    setOnlineLobbySubMode('join');
                    refreshAvailableRooms();
                  }}
                  className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all text-left flex flex-col justify-between cursor-pointer min-h-[220px]"
                >
                  <div>
                    <div className="mb-4 inline-block bg-indigo-200 p-3 rounded-xl border-2 border-black">
                      <Search size={24} />
                    </div>
                    <h3 className="text-lg font-black mb-2">公開ルームから選ぶ</h3>
                    <p className="text-[11px] font-bold text-gray-500 leading-relaxed">現在公開されており、参加者を募集している対戦ルームの一覧から選んで入室します。</p>
                  </div>
                  <span className="font-black text-indigo-600 text-xs mt-4 flex items-center gap-1">一覧を表示 <ArrowRight size={12} /></span>
                </button>

                {/* 3. Quick Join */}
                <button 
                  onClick={quickJoinOnline}
                  className="bg-indigo-50 border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all text-left flex flex-col justify-between cursor-pointer min-h-[220px]"
                >
                  <div>
                    <div className="mb-4 inline-block bg-indigo-500 text-white p-3 rounded-xl border-2 border-black">
                      <Zap size={24} />
                    </div>
                    <h3 className="text-lg font-black mb-2">クイック対戦</h3>
                    <p className="text-[11px] font-bold text-gray-500 leading-relaxed">パスワードのない公開ルームを自動検索して即座に対戦を開始！なければ部屋を作ります。</p>
                  </div>
                  <span className="font-black text-indigo-600 text-xs mt-4 flex items-center gap-1">クイック入室 <ArrowRight size={12} /></span>
                </button>

                {/* 4. Solo Practice */}
                <button 
                  onClick={() => setOnlineLobbySubMode('practiceConfig')}
                  className="bg-emerald-50 border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all text-left flex flex-col justify-between cursor-pointer min-h-[220px]"
                >
                  <div>
                    <div className="mb-4 inline-block bg-emerald-500 text-white p-3 rounded-xl border-2 border-black">
                      <Sparkles size={24} />
                    </div>
                    <h3 className="text-lg font-black mb-2">一人で練習 (CPU)</h3>
                    <p className="text-[11px] font-bold text-gray-500 leading-relaxed">おバカ〜聖徳太子レベルのCPUとオフライン or 1人でじっくり練習できます。</p>
                  </div>
                  <span className="font-black text-emerald-700 text-xs mt-4 flex items-center gap-1">練習設定へ <ArrowRight size={12} /></span>
                </button>
              </div>
            )}

            {/* Create Room Mode Forms */}
            {onlineLobbySubMode === 'create' && (
              <div className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] w-full max-w-2xl mx-auto">
                <h3 className="text-xl font-black mb-6 border-b-2 border-black pb-2 flex items-center gap-2">
                  <PlusCircle size={22} className="text-indigo-600" /> ルーム設定
                </h3>
                
                <div className="space-y-6">
                  {/* 一本勝負 / 三本勝負 */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合数（最大獲得星数で決定）</span>
                    <div className="grid grid-cols-3 gap-3">
                      {[1, 3, 5].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setCreateRoundsToWin(val)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            createRoundsToWin === val ? 'bg-indigo-600 text-white' : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {val === 1 ? '1 試合 (1勝先勝)' : val === 3 ? '3 試合 (2勝先勝)' : '5 試合 (3勝先勝)'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* プレイヤー数 */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合人数</span>
                    <div className="grid grid-cols-3 gap-3">
                      {[2, 3, 4].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setCreateMaxPlayers(val)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            createMaxPlayers === val ? 'bg-indigo-600 text-white' : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {val} 人対戦
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* レベル */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合難易度</span>
                    <div className="grid grid-cols-3 gap-3">
                      {(['normal', 'hard', 'hell'] as const).map((lvl) => (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => setCreateDifficulty(lvl)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm uppercase transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            createDifficulty === lvl 
                              ? lvl === 'hell' ? 'bg-red-600 text-white' : lvl === 'hard' ? 'bg-purple-600 text-white' : 'bg-yellow-400 text-black' 
                              : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {lvl === 'hell' ? '💀 HELL' : lvl === 'hard' ? '👾 HARD' : '🧠 NORMAL'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* パスワード */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700 flex items-center gap-1">
                      <Lock size={14} /> ◆ パスワード（任意・4桁数字）
                    </span>
                    <input
                      type="text"
                      maxLength={4}
                      value={createPassword}
                      onChange={(e) => setCreatePassword(e.target.value.replace(/\D/g, ''))} // 数字のみ
                      placeholder="パスワードなしの場合は空欄でOK"
                      className="w-full p-3 border-2 border-black rounded-lg text-sm font-semibold outline-none bg-gray-50 focus:bg-white"
                    />
                  </div>
                </div>

                <div className="flex gap-4 mt-8 pt-4 border-t-2 border-black">
                  <button
                    onClick={() => setOnlineLobbySubMode('options')}
                    className="flex-1 py-3 border-2 border-black font-extrabold text-sm rounded-lg hover:bg-gray-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                  >
                    戻る
                  </button>
                  <button
                    onClick={createOnlineRoom}
                    disabled={isLoadingRooms}
                    className="flex-1 py-3 bg-indigo-600 text-white font-black text-sm rounded-lg hover:bg-indigo-500 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center gap-2 active:scale-95 transition-all outline-none"
                  >
                    <span>{isLoadingRooms ? '作成中...' : '対戦ルームを作成'}</span>
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* Solo Practice Mode Forms */}
            {onlineLobbySubMode === 'practiceConfig' && (
              <div className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] w-full max-w-2xl mx-auto text-left">
                <h3 className="text-xl font-black mb-6 border-b-2 border-black pb-2 flex items-center gap-2">
                  <Sparkles size={22} className="text-emerald-600" /> 一人で練習（CPU対戦設定）
                </h3>
                
                <div className="space-y-6">
                  {/* CPUレベル選択 */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 対戦CPUのレベル</span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { key: 'easy', label: '👶 おバカ', desc: '遅め / 30%正答' },
                        { key: 'normal', label: '👂 ふつう', desc: '普通 / 60%正答' },
                        { key: 'hell', label: '💀 聖徳太子', desc: '超速 / 85%正答' },
                        { key: 'random', label: '❓ ランダム', desc: '混ざり合う' }
                      ].map((cpu) => (
                        <button
                          key={cpu.key}
                          type="button"
                          onClick={() => setPracticeCpuLevel(cpu.key as any)}
                          className={`flex flex-col items-center justify-center py-2.5 px-1 border-2 border-black font-extrabold rounded-lg text-sm transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            practiceCpuLevel === cpu.key 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          <span className="font-extrabold">{cpu.label}</span>
                          <span className="text-[10px] mt-0.5 opacity-80 font-bold">{cpu.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 一本勝負 / 三本勝負 */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合数</span>
                    <div className="grid grid-cols-3 gap-3">
                      {[1, 3, 5].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setPracticeRoundsToWin(val)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            practiceRoundsToWin === val ? 'bg-emerald-600 text-white' : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {val === 1 ? '1 試合' : val === 3 ? '3 試合' : '5 試合'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* プレイヤー数 */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合人数（あなた ＋ CPU）</span>
                    <div className="grid grid-cols-3 gap-3">
                      {[2, 3, 4].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setPracticeMaxPlayers(val)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            practiceMaxPlayers === val ? 'bg-emerald-600 text-white' : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {val === 2 ? '2人 (CPU 1名)' : val === 3 ? '3人 (CPU 2名)' : '4人 (CPU 3名)'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 難易度レベル */}
                  <div>
                    <span className="block font-black text-sm mb-2 text-gray-700">◆ 試合難易度</span>
                    <div className="grid grid-cols-3 gap-3">
                      {(['normal', 'hard', 'hell'] as const).map((lvl) => (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => setPracticeDifficulty(lvl)}
                          className={`py-3 border-2 border-black font-extrabold rounded-lg text-sm uppercase transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 ${
                            practiceDifficulty === lvl 
                              ? lvl === 'hell' ? 'bg-red-600 text-white' : lvl === 'hard' ? 'bg-purple-600 text-white' : 'bg-yellow-400 text-black' 
                              : 'bg-gray-50 text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {lvl === 'hell' ? '💀 HELL' : lvl === 'hard' ? '👾 HARD' : '🧠 NORMAL'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-4 mt-8 pt-4 border-t-2 border-black">
                  <button
                    onClick={() => setOnlineLobbySubMode('options')}
                    className="flex-1 py-3 border-2 border-black font-extrabold text-sm rounded-lg hover:bg-gray-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all text-center cursor-pointer"
                  >
                    戻る
                  </button>
                  <button
                    onClick={() => startPracticeGame(practiceCpuLevel, practiceDifficulty, practiceRoundsToWin, practiceMaxPlayers)}
                    disabled={isLoadingRooms}
                    className="flex-1 py-3 bg-emerald-600 text-white font-black text-sm rounded-lg hover:bg-emerald-500 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center gap-2 active:scale-95 transition-all outline-none cursor-pointer"
                  >
                    <span>{isLoadingRooms ? '準備中...' : '練習を開始する'}</span>
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* List and Joining Page */}
            {onlineLobbySubMode === 'join' && (
              <div className="flex flex-col gap-6 w-full">
                {/* 手動ルーム検索エリア */}
                <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-wrap gap-3 items-center">
                  <span className="font-black text-sm text-gray-700">ルームID検索: </span>
                  <input
                    type="text"
                    maxLength={4}
                    placeholder="E7K2 など"
                    id="manualRoomIdSearch"
                    className="p-2 border-2 border-black rounded-lg font-black uppercase tracking-widest text-sm w-32 outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const targetId = (document.getElementById('manualRoomIdSearch') as HTMLInputElement)?.value;
                        if (targetId) joinOnlineRoom(targetId);
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      const targetId = (document.getElementById('manualRoomIdSearch') as HTMLInputElement)?.value;
                      if (targetId) joinOnlineRoom(targetId);
                    }}
                    className="p-2 bg-indigo-600 text-white font-extrabold text-xs rounded-lg border-2 border-black hover:bg-indigo-500"
                  >
                    検索入室
                  </button>
                  <div className="ml-auto flex gap-2">
                    <button
                      onClick={refreshAvailableRooms}
                      className="p-2.5 bg-yellow-400 hover:bg-yellow-300 border-2 border-black rounded-lg text-xs font-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex items-center gap-1"
                    >
                      <RotateCw size={14} className={isLoadingRooms ? 'animate-spin' : ''} />
                      更新する
                    </button>
                    <button
                      onClick={() => setOnlineLobbySubMode('options')}
                      className="p-2.5 bg-white hover:bg-gray-50 border-2 border-black rounded-lg text-xs font-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                    >
                      戻る
                    </button>
                  </div>
                </div>

                {/* Available rooms body list  */}
                {isLoadingRooms ? (
                  <div className="bg-white border-4 border-black p-12 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-center font-black animate-pulse">
                    対戦ルームの一覧を読み込み中...
                  </div>
                ) : availableRooms.length === 0 ? (
                  <div className="bg-white border-4 border-black p-12 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-center">
                    <p className="font-black text-lg mb-2 text-gray-700">募集中ルームがありません</p>
                    <p className="text-xs font-bold text-gray-500 mb-6">「対戦ルームを作成」ボタンから自分で新しく部屋を作って友達を招待しよう！</p>
                    <button
                      onClick={() => setOnlineLobbySubMode('create')}
                      className="px-6 py-2 bg-indigo-600 text-white font-black text-sm border-2 border-black rounded-lg hover:bg-indigo-500 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                    >
                      自分で部屋を作成
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {availableRooms.map((room) => (
                      <div 
                        key={room.roomId}
                        className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between hover:-translate-y-0.5 transition-all"
                      >
                        <div>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-black text-xl tracking-widest text-indigo-700 uppercase">{room.roomId}</span>
                            {room.password && (
                              <span className="bg-red-50 text-red-600 text-[10px] px-1.5 py-0.5 border border-red-200 rounded font-black flex items-center gap-0.5" title="パスワード付き">
                                <Lock size={10} /> 鍵
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-extrabold text-gray-600 mb-2">ホスト：{room.hostName}</p>
                          <div className="flex flex-wrap gap-1.5">
                            <span className="text-[10px] bg-slate-100 text-slate-800 px-2 py-0.5 border border-gray-200 rounded-full font-black uppercase">
                              {room.difficulty === 'hell' ? '💀 HELL' : room.difficulty === 'hard' ? '👾 HARD' : '🧠 NORMAL'}
                            </span>
                            <span className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 border border-blue-100 rounded-full font-black">
                              {room.roundsToWin === 5 ? '3勝先勝' : room.roundsToWin === 3 ? '2勝先勝' : '1勝先勝'}
                            </span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-sm font-black mb-2 text-indigo-950/70">
                            人数： {room.players.length} / {room.maxPlayers}
                          </div>
                          <button
                            onClick={() => joinOnlineRoom(room.roomId)}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white border-2 border-black font-black text-xs rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 cursor-pointer"
                          >
                            参戦する
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {onlineLobbySubMode === 'quick' && (
              <div className="bg-white border-4 border-black p-12 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-center font-black flex flex-col items-center justify-center">
                <div className="animate-spin text-indigo-600 mb-4"><Zap size={40} /></div>
                <p className="text-lg">最適な対戦ルームを探しています...</p>
                <p className="text-xs text-gray-500 mt-2">対戦ルームが見つからない場合は自動的にあなたの設定で作成します。</p>
              </div>
            )}
          </motion.div>
        )}

        {/* ========================================================================= */}
        {/* ONLINE MULTIPLAYER WAITING ROOM (LOBBY STANDBY)                           */}
        {/* ========================================================================= */}
        {gameState === 'onlineRoom' && activeRoom && (
          <motion.div 
            key="onlineRoom"
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className="max-w-4xl mx-auto py-8 px-4 min-h-screen flex flex-col justify-start"
          >
            {/* Upper Info Header */}
            <div className="bg-white border-4 border-black p-5 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mb-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-[10px] bg-indigo-100 text-indigo-800 border border-indigo-200 px-2 py-1 rounded-full font-bold leading-none shrink-0">MUTIPLAYER WAITING</span>
                  <div className="flex items-center gap-1.5 text-slate-700 bg-slate-100 border border-slate-200 px-2.5 py-0.5 rounded-full shrink-0">
                    <div className="w-[15px] h-[15px] rounded-full border border-black overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
                      {accountIcon && accountIcon !== 'null' ? (
                        <img 
                          src={`assets/img/${accountIcon}_265.png`} 
                          alt="avatar" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <User size={8} className="text-gray-400" />
                      )}
                    </div>
                    <span className="text-[10px] font-black text-indigo-700">{onlinePlayerName}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <h1 className="text-2xl font-black">部屋番号: <span className="text-indigo-600 underline tracking-widest uppercase">{activeRoom.roomId}</span></h1>
                  <button 
                    onClick={copyRoomUrlToClipboard}
                    className="flex items-center gap-1.5 px-3 py-1 bg-yellow-300 hover:bg-yellow-200 border-2 border-black font-black text-xs rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer"
                  >
                    <Share2 size={12} />
                    <span>{isCopying ? 'コピーしました！' : 'URLを共有する'}</span>
                  </button>
                  <button 
                    onClick={() => {
                      const newVal = !joinSeEnabled;
                      setJoinSeEnabled(newVal);
                      localStorage.setItem('kikimimi_join_se_enabled', newVal ? 'true' : 'false');
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1 border-2 border-black font-black text-xs rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] cursor-pointer transition-colors ${
                      joinSeEnabled 
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700' 
                        : 'bg-gray-150 bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {joinSeEnabled ? <Volume2 size={12} /> : <XCircle size={12} />}
                    <span>入室音: {joinSeEnabled ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
                <div className="mt-2 text-xs font-bold text-slate-500 leading-relaxed max-w-xl">
                  URLを共有するをクリックして得たURLを知人に送れば、直接この部屋に招待できます。部屋を立てるときにパスワードを使用していた場合、パスワードもあわせてお伝えください。
                </div>
              </div>

              <div className="flex items-center gap-2">
                {activeRoom.hostId === onlinePlayerId ? (
                  <button 
                    onClick={leaveOnlineRoom}
                    className="px-4 py-2 bg-red-100 text-red-600 hover:bg-red-200 border-2 border-black font-extrabold text-sm rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all text-center cursor-pointer h-[42px]"
                  >
                    ルームを閉じて解散
                  </button>
                ) : (
                  <button 
                    onClick={leaveOnlineRoom}
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 border-2 border-black font-extrabold text-sm rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all text-center cursor-pointer h-[42px]"
                  >
                    退出する
                  </button>
                )}
              </div>
            </div>

            {/* Main setup layout splits columns */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
              {/* Rules and Setup card */}
              <div className="bg-white border-4 border-black p-5 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left flex flex-col justify-between">
                <div>
                  <h3 className="text-lg font-black border-b-2 border-black pb-1.5 mb-4 flex items-center gap-2">
                    <Sliders size={18} /> 対戦ルール
                  </h3>
                  <div className="space-y-4 font-bold text-sm text-slate-700">
                    <div className="flex justify-between border-b pb-1.5">
                      <span>対戦難易度：</span>
                      <span className="text-indigo-600 font-black uppercase">
                        {activeRoom.difficulty === 'hell' ? '💀 HELL' : activeRoom.difficulty === 'hard' ? '👾 HARD' : '🧠 NORMAL'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b pb-1.5">
                      <span>必要星数：</span>
                      <span className="text-indigo-600 text-black">
                        {activeRoom.roundsToWin === 5 ? '★3勝で優勝' : activeRoom.roundsToWin === 3 ? '★2勝で優勝' : '★1勝で優勝'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b pb-1.5">
                      <span>目標人数：</span>
                      <span className="text-black">{activeRoom.players.length} / {activeRoom.maxPlayers}人</span>
                    </div>
                    <div className="flex justify-between border-b pb-1.5">
                      <span>パスワード：</span>
                      <span className="text-black">{activeRoom.password ? 'あり' : 'なし'}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-8 pt-4 border-t border-gray-100 bg-gray-50 -mx-5 -mb-5 p-4 rounded-b-xl border-t-2 border-black text-center">
                  <p className="text-xs font-black text-indigo-900 leading-relaxed uppercase">
                    ◆ {activeRoom.maxPlayers} 人集まると自動でゲームスタート！ ◆
                  </p>
                </div>
              </div>

              {/* Connected Players list */}
              <div className="md:col-span-2 bg-white border-4 border-black p-5 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left">
                <h3 className="text-lg font-black border-b-2 border-black pb-1.5 mb-4 flex items-center gap-2">
                  <Users size={18} /> 参加しているプレイヤー
                </h3>

                <div className="space-y-3 mb-6">
                  {activeRoom.players.map((player: any) => (
                    <div 
                      key={player.id}
                      className={`flex items-center justify-between p-3.5 border-4 border-black rounded-lg shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] ${
                        player.id === onlinePlayerId ? 'bg-indigo-50 border-indigo-600' : 'bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="bg-slate-100 rounded-full border border-black w-9 h-9 flex items-center justify-center overflow-hidden shrink-0">
                          {player.icon && player.icon !== 'null' ? (
                            <img 
                              src={`assets/img/${player.icon}_265.png`} 
                              alt="avatar" 
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="font-black uppercase text-xs text-black block">
                              {player.name.slice(0, 2)}
                            </span>
                          )}
                        </div>
                        <div>
                          <p className="font-black text-sm text-slate-800 flex items-center gap-1">
                            {player.name}
                            {player.isHost && (
                              <span className="bg-yellow-400 text-black border border-black text-[9px] px-1 py-0.2 rounded font-black">
                                👑 部屋主
                              </span>
                            )}
                          </p>
                          <span className="text-[10px] text-gray-400 font-extrabold">プレイヤーID: {player.id.slice(0, 6)}</span>
                        </div>
                      </div>

                      <div>
                        {player.isHost ? (
                          <span className="bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-black px-3 py-1 rounded">
                            ホスト
                          </span>
                        ) : player.isReady ? (
                          <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs font-black px-3 py-1 rounded-full flex items-center gap-1">
                            ✔ 準備完了
                          </span>
                        ) : (
                          <span className="bg-slate-100 text-slate-500 border border-slate-200 text-xs font-black px-3 py-1 rounded-full">
                            待機中...
                          </span>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Empty slots placeholders */}
                  {Array.from({ length: activeRoom.maxPlayers - activeRoom.players.length }).map((_, i) => (
                    <div 
                      key={i}
                      className="border-2 border-dashed border-gray-300 p-3.5 rounded-lg text-center flex items-center justify-center text-xs font-bold text-gray-400"
                    >
                      <span>対戦相手を待機中...</span>
                    </div>
                  ))}
                </div>

                {/* Lower Action bar for Guest to Ready status */}
                {activeRoom.hostId !== onlinePlayerId && (
                  <button
                    onClick={toggleReadyOnline}
                    className={`w-full py-4 border-4 border-black font-black rounded-xl text-lg shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer ${
                      activeRoom.players.find((p: any) => p.id === onlinePlayerId)?.isReady 
                        ? 'bg-red-400 hover:bg-red-300 text-black' 
                        : 'bg-emerald-400 hover:bg-emerald-300 text-black'
                    }`}
                  >
                    {activeRoom.players.find((p: any) => p.id === onlinePlayerId)?.isReady 
                      ? '準備完了をキャンセル' 
                      : '準備完了にマークする！'}
                  </button>
                )}

                {/* ホスト専用: 人数が足りない場合のアクション */}
                {activeRoom.hostId === onlinePlayerId && activeRoom.players.length < activeRoom.maxPlayers && (
                  <div className="p-4 bg-indigo-50 border-4 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left space-y-4">
                    <p className="font-black text-sm text-indigo-950 flex items-center gap-1.5">
                      <Sliders size={16} /> 部屋主メニュー: 人数が集まらない場合
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* インライン「今いる人数で開始」 */}
                      <button
                        onClick={startWithCurrentPlayers}
                        disabled={activeRoom.players.length < 2}
                        className="py-3 bg-white hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:shadow-none disabled:cursor-not-allowed text-black border-2 border-black font-extrabold text-sm rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer text-center"
                        title={activeRoom.players.length < 2 ? "自分以外のプレイヤーがいません。CPUを追加するか、他のプレイヤーを待ってください。" : ""}
                      >
                        今いる人数（{activeRoom.players.length}人）で開始
                      </button>

                      {/* インライン「CPUで埋めて開始」 */}
                      <div className="flex flex-col gap-2 bg-white p-3 rounded-lg border-2 border-black">
                        <span className="text-xs font-black text-gray-700">CPUの強さを選んで開始:</span>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => fillWithCpu('easy')}
                            className="py-1.5 px-2 bg-yellow-300 hover:bg-yellow-200 border-2 border-black font-black text-xs rounded shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer text-center"
                          >
                            👶 おバカで埋める
                          </button>
                          <button
                            onClick={() => fillWithCpu('normal')}
                            className="py-1.5 px-2 bg-indigo-500 hover:bg-indigo-400 text-white border-2 border-black font-black text-xs rounded shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer text-center"
                          >
                            👂 ふつうで埋める
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ========================================================================= */}
        {/* ONLINE MULTIPLAYER LIVE GAMEPLAY SCREEN                                   */}
        {/* ========================================================================= */}
        {gameState === 'onlineGame' && activeRoom && (
          <motion.div 
            key="onlineGame"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="relative max-w-7xl mx-auto p-4 md:p-8 min-h-screen flex flex-col justify-start"
          >
            {/* 1. Header with Synced Stats bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6 bg-white p-4 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] rounded-2xl">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full border-2 border-black flex items-center justify-center overflow-hidden bg-white">
                  <img 
                    src={CHARACTERS[targetChar].image} 
                    alt={CHARACTERS[targetChar].name} 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div>
                  <h3 className="font-black text-sm">【ターゲットキャラ】</h3>
                  <p className="font-extrabold text-lg text-indigo-700 flex items-center gap-1 leading-none">{CHARACTERS[targetChar].name} <span className="text-xs bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded font-black uppercase">{activeRoom.difficulty}</span></p>
                </div>
              </div>

              {/* Connected Standby Players Live Tracker (お互いの解答状況)  */}
              <div className="flex items-center gap-2 flex-wrap">
                {activeRoom.players.map((plr: any) => {
                  const isSelf = plr.id === onlinePlayerId;
                  const iconKey = isSelf ? (accountIcon && accountIcon !== 'null' ? accountIcon : plr.icon) : (plr.icon && plr.icon !== 'null' ? plr.icon : null);
                  return (
                    <div 
                      key={plr.id}
                      className={`px-3 py-1.5 rounded-lg border-2 border-black font-black text-xs flex items-center gap-1.5 relative ${
                        plr.id === onlinePlayerId ? 'bg-indigo-50 ring-2 ring-indigo-300' : 'bg-white'
                      }`}
                    >
                      {/* プレイヤーのアイコンを表示 */}
                      <div className="w-[28px] h-[28px] rounded-full border border-black overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
                        {iconKey ? (
                          <img 
                            src={`assets/img/${iconKey}_265.png`} 
                            alt="avatar" 
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <User size={16} className="text-gray-400" />
                        )}
                      </div>

                      <span className="max-w-[80px] truncate block">{plr.name}</span>
                      
                      {/* 星のカウント(テキスト) */}
                      <span className="flex items-center gap-0.5 text-amber-500 font-extrabold text-xs">
                        ⭐ {plr.stars || 0}
                      </span>

                      {/* 状況バッジ */}
                      {plr.status === 'fault' && (
                        <span className="absolute -top-2.5 -right-1.5 bg-red-500 text-white font-black px-1 rounded-md text-[8px] uppercase rotate-12">
                          誤答！
                        </span>
                      )}
                      {plr.status === 'winner' && (
                        <span className="absolute -top-2.5 -right-1.5 bg-emerald-500 text-white font-black px-1 rounded-md text-[8px] uppercase">
                          正解！
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Status or Round counts */}
              <div className="flex items-center gap-2">
                <span className="bg-black text-white font-black text-sm px-4 py-2 border-2 border-black rounded-lg h-[38px] flex items-center">
                  対戦：ラウンド {activeRoom.currentRound || 1}
                </span>
              </div>
            </div>

            {/* お手付き通知トースト（リアルタイムでお知らせ） */}
            {activeRoom.answerState && activeRoom.answerState.isOngoingFault && (
              <div className="mb-4 p-3 bg-red-100 border-4 border-red-500 text-red-500 font-black rounded-xl text-center shadow-[4px_4px_0px_0px_rgba(239, 68, 68, 0.1)] text-sm animate-pulse">
                💥 プレイヤー {activeRoom.answerState.playerName} がお手付きしました！回答権を失います。
              </div>
            )}

            {/* Active Stage Renderer */}
            {/* A. Sampling stage (試聴中、25秒) */}
            {activeRoom.status === 'sampling' && (
              <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 border-4 border-black p-8 rounded-3xl text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] my-auto flex flex-col items-center justify-center max-w-2xl mx-auto">
                <span className="text-sm font-black bg-indigo-200 text-indigo-800 px-4 py-1.5 rounded-full uppercase mb-4 tracking-wider leading-none">
                  サンプルボイス試聴フェーズ
                </span>
                <p className="font-extrabold text-sm text-indigo-950/70 mb-4 bg-white/40 border border-indigo-200 px-3 py-1 rounded">
                  このキャラが何を言ったか当ててね！
                </p>

                <div className="w-28 h-28 border-4 border-black rounded-full overflow-hidden bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] mb-6">
                  <img 
                    src={CHARACTERS[targetChar].image} 
                    alt={CHARACTERS[targetChar].name} 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>

                <div className="flex gap-4 w-full justify-center mb-10 flex-wrap">
                  <button
                    onClick={() => playSampleVoice(targetChar)}
                    disabled={isPlaying}
                    className="px-6 py-4 bg-white border-4 border-black font-black text-lg rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer"
                  >
                    <Volume2 size={20} />
                    <span>サンプルを再生</span>
                  </button>
                  <button
                    onClick={markReadyForOnlineRound}
                    disabled={isReadyForOnlineRound}
                    className={`px-6 py-4 border-4 border-black font-black text-lg rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer ${
                      isReadyForOnlineRound ? 'bg-gray-300 text-gray-500 border-gray-400' : 'bg-black text-white hover:bg-gray-800'
                    }`}
                  >
                    <Zap size={20} />
                    <span>{isReadyForOnlineRound ? '準備OK完了' : '本番に臨む！'}</span>
                  </button>
                </div>

                {/* 25 seconds visual layout */}
                <div className="w-full bg-indigo-50 border-2 border-black rounded-xl p-3 flex items-center justify-between">
                  <span className="font-black text-xs text-indigo-800 uppercase">自動で本番へ強制移行: </span>
                  <span className="font-black text-indigo-700 bg-white border-2 border-black w-10 h-10 flex items-center justify-center rounded-lg text-lg">
                    {onlineSampleTimeLeft}s
                  </span>
                </div>
              </div>
            )}

            {/* B. Countdown Stage (3 seconds) */}
            {activeRoom.status === 'ready_countdown' && (
              <div className="my-auto flex flex-col items-center justify-center max-w-lg mx-auto text-center py-20">
                <div className="relative w-48 h-48 bg-yellow-300 border-4 border-black rounded-full shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center overflow-hidden">
                  <motion.span 
                    key={onlineCountdown}
                    initial={{ scale: 0.2, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="font-black text-black text-8xl"
                  >
                    {onlineCountdown > 0 ? onlineCountdown : 'GO!'}
                  </motion.span>
                </div>
                <p className="font-black text-xl mt-8">【 本番開始 】</p>
              </div>
            )}

            {/* C. Playing Stage & D. Hand selections */}
            {activeRoom.status === 'playing' && (
              <div className="w-full flex flex-col items-stretch flex-1 gap-4">
                
                {/* 自分が解答完了している場合は待機画面を出す */}
                {(() => {
                  const myPl = activeRoom.players.find((p: any) => p.id === onlinePlayerId);
                  
                  if (myPl && myPl.status === 'answered') {
                    // 正答して他の解答者を待機中
                    const correctSorted = [...activeRoom.players]
                      .filter((p: any) => p.status === 'answered')
                      .sort((a: any, b: any) => (a.submitTime || 999) - (b.submitTime || 999));
                    const myRank = correctSorted.findIndex((p: any) => p.id === onlinePlayerId) + 1;
                    const myTime = myPl.submitTime || 0;

                    return (
                      <div className="flex flex-col gap-6 max-w-xl mx-auto w-full text-center py-12">
                        {/* タイムバー */}
                        <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Clock size={16} className="text-indigo-600 shrink-0" />
                            <span className="font-black text-xs text-gray-600">残り解答時間（制限時間）:</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="font-black text-2xl text-red-600">{timeLeft}</span>
                            <span className="font-bold text-xs text-gray-400">秒</span>
                          </div>
                        </div>

                        <div className="bg-emerald-100/90 text-emerald-950 font-black p-8 border-4 border-black rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-center">
                          <p className="text-4xl mb-4 font-black text-emerald-800">🎉 正解！</p>
                          <p className="text-lg font-bold mb-1">
                            あなたは現在 <span className="text-3xl font-black underline text-indigo-700">{myRank}</span> 位で完了！({myTime.toFixed(1)}秒)
                          </p>
                          <p className="text-sm font-bold text-emerald-600 animate-pulse mt-2">他のプレイヤーを待っています...</p>
                        </div>
                      </div>
                    );
                  } else if (myPl && myPl.status === 'fault') {
                    // お手付きして他の解答者を待機中
                    return (
                      <div className="flex flex-col gap-6 max-w-xl mx-auto w-full text-center py-12">
                        <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Clock size={16} className="text-indigo-600 shrink-0" />
                            <span className="font-black text-xs text-gray-600">残り解答時間（制限時間）:</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="font-black text-2xl text-red-600">{timeLeft}</span>
                            <span className="font-bold text-xs text-gray-400">秒</span>
                          </div>
                        </div>

                        <div className="bg-red-50 text-red-950 font-black p-8 border-4 border-black rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] text-center">
                          <p className="text-4xl mb-4 font-black text-red-600">🚨 お手付き</p>
                          <p className="text-lg font-bold mb-2 text-red-900">
                            お手付きしました。他のプレイヤーを待っています
                          </p>
                          <p className="text-xs text-red-700 font-medium">このラウンドの回答権は失われました。ラウンド終了までお待ちください。</p>
                        </div>
                        
                        {/* 誤答と正答を表示（暇つぶし用） */}
                        {(() => {
                          const getCardTextLocal = (colKey: 'who' | 'where' | 'why' | 'what', voiceKey: string | null) => {
                            if (!voiceKey) return '未選択';
                            if (!activeRoom || !activeRoom.currentProblem || !activeRoom.currentProblem.options) return voiceKey;
                            const list = activeRoom.currentProblem.options[colKey];
                            if (!list) return voiceKey;
                            const found = list.find((item: any) => item.voice === voiceKey);
                            return found ? found.card : voiceKey;
                          };
                          const curTargetAnswers = activeRoom?.currentProblem?.targetAnswers || targetAnswers;
                          return (
                            <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left text-black mt-2">
                              <h4 className="font-black text-sm text-red-600 mb-3 flex items-center gap-1">
                                🔍 あなたの誤答 ＆ この問題の正答
                              </h4>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-bold">
                                <div className="bg-red-50 border-2 border-red-200 p-3 rounded-lg">
                                  <p className="text-red-800 font-extrabold mb-1.5 uppercase tracking-wide">🔴 あなたの答え</p>
                                  <div className="space-y-1">
                                    <p className="flex items-center gap-1.5"><strong className="text-gray-500">誰が (Who):</strong> {getCardTextLocal('who', selections.who)}</p>
                                    <p className="flex items-center gap-1.5"><strong className="text-gray-500">どこで (Where):</strong> {getCardTextLocal('where', selections.where)}</p>
                                    {(activeRoom.difficulty === 'hard' || activeRoom.difficulty === 'hell') && (
                                      <p className="flex items-center gap-1.5"><strong className="text-gray-500">なぜ (Why):</strong> {getCardTextLocal('why', selections.why)}</p>
                                    )}
                                    <p className="flex items-center gap-1.5"><strong className="text-gray-500">何を (What):</strong> {getCardTextLocal('what', selections.what)}</p>
                                  </div>
                                </div>
                                <div className="bg-green-50 border-2 border-green-200 p-3 rounded-lg">
                                  <p className="text-green-800 font-extrabold mb-1.5 uppercase tracking-wide">🟢 正解</p>
                                  <div className="space-y-1">
                                    <p className="flex items-center gap-1.5"><strong className="text-gray-500">誰が (Who):</strong> {curTargetAnswers[0]?.card || '???'}</p>
                                    <p className="flex items-center gap-1.5"><strong className="text-gray-500">どこで (Where):</strong> {curTargetAnswers[1]?.card || '???'}</p>
                                    {(activeRoom.difficulty === 'hard' || activeRoom.difficulty === 'hell') ? (
                                      <>
                                        <p className="flex items-center gap-1.5"><strong className="text-gray-500">なぜ (Why):</strong> {curTargetAnswers[2]?.card || '???'}</p>
                                        <p className="flex items-center gap-1.5"><strong className="text-gray-500">何を (What):</strong> {curTargetAnswers[3]?.card || '???'}</p>
                                      </>
                                    ) : (
                                      <p className="flex items-center gap-1.5"><strong className="text-gray-500">何を (What):</strong> {curTargetAnswers[2]?.card || '???'}</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  } else {
                    // 通常の解答画面（未解答 'idle' の場合）
                    return (
                      <>
                        <div className="flex flex-col sm:flex-row gap-3">
                          {/* タイムバー */}
                          <div className="flex-1 bg-white border-4 border-black p-3 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Clock size={16} className="text-indigo-600 shrink-0" />
                              <span className="font-black text-xs text-gray-600">残り解答時間（最速押しチャンス）:</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="font-black text-2xl text-red-600">{timeLeft}</span>
                              <span className="font-bold text-xs text-gray-400">秒</span>
                            </div>
                          </div>

                          {/* 再生コントロール */}
                          <div className="flex-1 bg-yellow-50 border-4 border-black p-2.5 rounded-xl flex items-center justify-between shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <div className="flex items-center gap-2 min-w-0">
                              <Volume2 size={16} className="text-yellow-600 shrink-0" />
                              <div className="min-w-0 text-left">
                                <span className="block font-black text-xs text-yellow-800 uppercase leading-none">再生コントロール</span>
                                <span className="text-[10px] text-yellow-950/60 font-bold block mt-1 leading-tight truncate sm:whitespace-normal">
                                  何度も聴き分け可能！（リピート自由）
                                </span>
                              </div>
                            </div>
                            <button
                              onClick={playSimultaneous}
                              disabled={isPlaying}
                              className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 border-2 border-black rounded-lg font-black text-xs shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none cursor-pointer flex items-center gap-1 active:scale-95 text-black shrink-0 ml-2"
                            >
                              <span>{isPlaying ? '再生中...' : '声を聴き直す'}</span>
                            </button>
                          </div>
                        </div>

                        {/* Columns selections grid in independent shuffle - SELECTIONS */}
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 flex-1">
                          {/* --- WHO列 (独立) --- */}
                          <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <h4 className="font-black text-sm border-b-2 border-black pb-1.5 mb-3 text-gray-800 flex items-center gap-1"><User size={14} /> 誰が (Who)</h4>
                            {activeRoom.currentProblem.options.who.map((vo: VoiceData) => (
                              <Card 
                                key={vo.voice} 
                                data={vo} 
                                selected={selections.who === vo.voice} 
                                onSelect={() => setSelections(prev => ({ ...prev, who: vo.voice }))} 
                                icon={User} 
                              />
                            ))}
                          </div>

                          {/* --- WHERE列 (独立) --- */}
                          <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <h4 className="font-black text-sm border-b-2 border-black pb-1.5 mb-3 text-gray-800 flex items-center gap-1"><MapPin size={14} /> どこで (Where)</h4>
                            {activeRoom.currentProblem.options.where.map((vo: VoiceData) => (
                              <Card 
                                key={vo.voice} 
                                data={vo} 
                                selected={selections.where === vo.voice} 
                                onSelect={() => setSelections(prev => ({ ...prev, where: vo.voice }))} 
                                icon={MapPin} 
                              />
                            ))}
                          </div>

                          {/* --- WHY / WHAT列 (独立) --- */}
                          {(activeRoom.difficulty === 'hard' || activeRoom.difficulty === 'hell') && (
                            <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                              <h4 className="font-black text-sm border-b-2 border-black pb-1.5 mb-3 text-gray-800 flex items-center gap-1"><HelpCircle size={14} /> なぜ (Why)</h4>
                              {activeRoom.currentProblem.options.why.map((vo: VoiceData) => (
                                <Card 
                                  key={vo.voice} 
                                  data={vo} 
                                  selected={selections.why === vo.voice} 
                                  onSelect={() => setSelections(prev => ({ ...prev, why: vo.voice }))} 
                                  icon={HelpCircle} 
                                />
                              ))}
                            </div>
                          )}

                          <div className="bg-white border-4 border-black p-4 rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <h4 className="font-black text-sm border-b-2 border-black pb-1.5 mb-3 text-gray-800 flex items-center gap-1"><Sparkles size={14} /> 何を (What)</h4>
                            {activeRoom.currentProblem.options.what.map((vo: VoiceData) => (
                              <Card 
                                key={vo.voice} 
                                data={vo} 
                                selected={selections.what === vo.voice} 
                                onSelect={() => setSelections(prev => ({ ...prev, what: vo.voice }))} 
                                icon={Sparkles} 
                              />
                            ))}
                          </div>
                        </div>

                        {/* Submit layout buttons action bar */}
                        <div className="flex bg-white border-4 border-black p-4 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mt-4 items-center gap-4">
                          <div className="flex-1 font-bold text-xs text-gray-500">
                            すべての項目を選択の上、「回答を決定！」ボタンを押してください。スピード勝負！
                          </div>
                          <button
                            onClick={submitOnlineAnswer}
                            disabled={
                              !selections.who || !selections.where || !selections.what || 
                              ((activeRoom.difficulty === 'hard' || activeRoom.difficulty === 'hell') && !selections.why)
                            }
                            className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-200 text-white disabled:text-gray-400 border-2 border-black cursor-pointer shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] disabled:shadow-none hover:shadow-none active:scale-95 transition-all rounded-xl font-black text-lg"
                          >
                            回答を決定して送信！
                          </button>
                        </div>
                      </>
                    );
                  }
                })()}
              </div>
            )}

            {/* D. Round Result Stage */}
            {activeRoom.status === 'round_result' && activeRoom.answerState && (
              <div className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] max-w-2xl mx-auto w-full my-auto text-center flex flex-col justify-between">
                <div>
                  <h3 className="text-2xl font-black mb-6 border-b-2 border-black pb-2">ラウンド判定結果！</h3>
                  
                  {/* ラウンドメンバーのリザルトリスト */}
                  <div className="mb-6 space-y-2">
                    {activeRoom.answerState.results?.map((res: any, idx: number) => {
                      let bgClass = "bg-white";
                      let statusText = "";
                      let timeText = res.submitTime ? `${res.submitTime.toFixed(1)} 秒` : "-";
                      let scoreAddText = "";

                      if (res.status === 'answered') {
                        bgClass = "bg-emerald-50 border-emerald-300";
                        statusText = "正解";
                        if (res.starsAdded > 0) {
                          scoreAddText = `☆ +${res.starsAdded}`;
                        }
                      } else if (res.status === 'fault') {
                        bgClass = "bg-red-50 border-red-300 text-red-950";
                        statusText = "お手付き";
                      } else if (res.status === 'timeout') {
                        bgClass = "bg-gray-100 border-gray-300 text-gray-500";
                        statusText = "時間切れ（未回答）";
                      } else {
                        statusText = "未回答";
                      }

                      return (
                        <div 
                          key={res.id} 
                          className={`p-3 border-2 border-black rounded-xl flex items-center justify-between text-sm font-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${bgClass}`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="w-14 text-center py-0.5 rounded-full bg-black text-white text-xs border border-black flex items-center justify-center font-black">
                              {idx + 1} 位
                            </span>
                            <span className="font-extrabold">{res.name} {res.id === onlinePlayerId ? "(あなた)" : ""}</span>
                            <span className="bg-amber-50 border border-amber-300 text-amber-800 font-extrabold px-1.5 py-0.5 rounded text-[10px]">
                              ☆:{res.stars || 0}
                            </span>
                          </div>
                          
                          <div className="flex items-center gap-4 text-xs">
                            <span className="font-bold text-gray-700">{statusText} ({timeText})</span>
                            {scoreAddText && (
                              <span className="bg-indigo-100 border border-indigo-300 text-indigo-800 font-extrabold px-2 py-0.5 rounded-lg text-[10px]">
                                {scoreAddText}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 正解のフレーズを大発表 */}
                  <div className="bg-indigo-50 border-2 border-indigo-200 p-4 rounded-xl text-left font-bold mb-6">
                    <span className="text-[10px] bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded uppercase block w-max mb-1.5 font-black">正解の答え</span>
                    <p className="text-xs text-gray-400">ターゲット【{CHARACTERS[targetChar].name}】：</p>
                    {activeRoom.difficulty === 'hard' || activeRoom.difficulty === 'hell' ? (
                      <p className="text-base text-indigo-900 mt-1">
                        「 {activeRoom.currentProblem.targetAnswers[0].card} 」「 {activeRoom.currentProblem.targetAnswers[1].card} 」「 {activeRoom.currentProblem.targetAnswers[2].card} 」「 {activeRoom.currentProblem.targetAnswers[3].card} 」
                      </p>
                    ) : (
                      <p className="text-base text-indigo-900 mt-1">
                        「 {activeRoom.currentProblem.targetAnswers[0].card} 」「 {activeRoom.currentProblem.targetAnswers[1].card} 」「 {activeRoom.currentProblem.targetAnswers[2].card} 」
                      </p>
                    )}
                  </div>
                </div>

                {/* ホストアクション / ゲスト待機 */}
                <div className="pt-4 border-t-2 border-black">
                  {(() => {
                    const hasOtherHuman = activeRoom.players.some((p: any) => !p.isCpu && p.id !== onlinePlayerId);
                    return (
                      <div className="flex flex-col gap-2">
                        {hasOtherHuman && (
                          <div className="text-xs font-bold text-red-500 mb-2">
                            ⏰ 他のプレイヤーがいます。あと <span className="text-sm font-black underline">{roundResultWaitTimeLeft}</span> 秒で自動的に次へ進みます。
                          </div>
                        )}
                        {activeRoom.hostId === onlinePlayerId ? (
                          (() => {
                            const isGameSet = checkOnlineGameSet(
                              activeRoom.players, 
                              activeRoom.roundsToWin, 
                              activeRoom.currentRound || 1
                            );
                            return (
                              <button
                                onClick={nextOnlineRound}
                                className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-lg border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all rounded-xl cursor-pointer"
                              >
                                {isGameSet ? '最終結果を見る' : '次のラウンドに進む'}
                              </button>
                            );
                          })()
                        ) : (
                          <div className="p-4 bg-gray-50 border-2 border-dashed border-gray-300 text-gray-500 font-black text-sm rounded-xl animate-pulse">
                            ルーム主が次の画面を切り替えるのを待っています...
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* E. Game Over Stage */}
            {activeRoom.status === 'game_over' && (
              <div className="bg-white border-4 border-black p-6 rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] max-w-2xl mx-auto w-full my-auto text-center">
                <Crown size={50} className="text-yellow-400 fill-yellow-300 mx-auto animate-bounce mb-2" />
                <h3 className="text-3xl font-black mb-1">結果発表！</h3>
                <p className="text-xs text-gray-400 font-bold mb-6 border-b border-gray-100 pb-2">対戦ルーム内の全てのラウンドが完了しました。</p>

                {/* ランキング発表リスト */}
                <div className="space-y-3 mb-8">
                  {[...activeRoom.players]
                    .sort((a: any, b: any) => b.stars - a.stars)
                    .map((item: any, rank: number) => {
                      const iconKey = item.icon && item.icon !== 'null' ? item.icon : null;
                      return (
                        <div 
                          key={item.id}
                          className={`p-4 border-4 border-black rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between ${
                            rank === 0 ? 'bg-yellow-100 ring-2 ring-yellow-400' : 'bg-white'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className={`w-8 h-8 rounded-full border-2 border-black font-extrabold flex items-center justify-center text-sm shrink-0 ${
                              rank === 0 ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {rank + 1}
                            </span>
                            
                            {/* プレイヤーアバター表示 */}
                            <div className="w-[32px] h-[32px] rounded-full border border-black overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
                              {iconKey ? (
                                <img 
                                  src={`assets/img/${iconKey}_265.png`} 
                                  alt="avatar" 
                                  className="w-full h-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <User size={16} className="text-gray-400" />
                              )}
                            </div>

                            <span className="font-black text-base">{item.name}</span>
                          </div>
                          <div className="font-extrabold text-sm text-red-600 flex items-center gap-1">
                            ☆:<span className="text-lg font-black">{item.stars}</span>
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col sm:flex-row gap-3 border-t-2 border-black pt-5">
                  <button
                    onClick={() => leaveOnlineRoom('onlineLobby')}
                    className="flex-1 py-4 bg-emerald-600 hover:bg-emerald-500 text-white border-2 border-black font-black text-sm rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer"
                  >
                    ロビーに戻る
                  </button>
                  <button
                    onClick={() => leaveOnlineRoom('start')}
                    className="flex-1 py-4 border-2 border-black font-extrabold text-sm rounded-xl hover:bg-gray-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer"
                  >
                    ロビーを退出する
                  </button>
                  {activeRoom.hostId === onlinePlayerId ? (
                    <button
                      onClick={handleFinishedOnlineGame}
                      className="flex-1 py-4 bg-indigo-600 hover:bg-indigo-500 text-white border-2 border-black font-black text-sm rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:scale-95 transition-all cursor-pointer"
                    >
                      もう一度遊ぶ（再戦！）
                    </button>
                  ) : (
                    <div className="flex-1 p-3.5 bg-gray-50 border-2 border-dashed border-gray-300 text-gray-500 font-bold text-xs rounded-xl animate-pulse flex items-center justify-center">
                      ホストが次の選択をしています...
                    </div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {gameState === 'reveal' && (
          <motion.div 
            key="reveal"
            initial={{ x: 100, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -100, opacity: 0 }}
            className="max-w-xl mx-auto flex flex-col items-center justify-center min-h-screen p-6 text-center"
          >
            {isChallenge && (
              <div className="mb-4 bg-yellow-400 text-black font-black px-6 py-2 border-4 border-black rounded-xl inline-block shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-lg animate-pulse">
                CHALLENGE: ROUND {currentRound} / 3
              </div>
            )}

            <div className="mb-6">
              <div 
                className="w-32 h-32 mx-auto my-4 border-4 border-black rounded-full shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center overflow-hidden bg-white"
              >
                <img 
                  src={CHARACTERS[targetChar].image} 
                  alt={CHARACTERS[targetChar].name} 
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
              <h2 className="text-4xl font-black">【{CHARACTERS[targetChar].name}】</h2>
              <p className="mt-4 font-bold text-lg">このキャラが何を言ったか当ててね！</p>
            </div>

            <div className="flex flex-col gap-4 w-full">
              <div className="flex gap-4 w-full">
                <button
                  onClick={() => playSampleVoice(targetChar)}
                  disabled={isPlaying}
                  className="flex-1 flex items-center justify-center gap-2 p-4 bg-white border-4 border-black font-black text-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 disabled:opacity-50"
                >
                  <Volume2 /> サンプルを聴く
                </button>
                <button
                  onClick={startMainGame}
                  className="flex-1 flex items-center justify-center gap-2 p-4 bg-black text-white font-black text-xl shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)] hover:bg-gray-800"
                >
                  本番に挑む
                </button>
              </div>
              
              {isChallenge && (
                <button
                  onClick={() => {
                    stopAllAudio();
                    setGameState('start');
                    setIsChallenge(false);
                  }}
                  className="w-full text-center p-3 border-4 border-red-500 hover:bg-red-50 text-red-500 font-extrabold text-lg shadow-[4px_4px_0px_0px_rgba(239,68,68,0.2)] transition-all bg-white"
                >
                  途中でやめる
                </button>
              )}
            </div>
          </motion.div>
        )}

        {gameState === 'main' && (
          <motion.div 
            key="main"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="relative max-w-7xl mx-auto p-4 md:p-8 min-h-[60vh]"
          >
            {/* ぼやけさせるコンテンツ */}
            <div className={`transition-all duration-300 ${!hasStarted ? 'blur-md pointer-events-none select-none opacity-50' : ''}`}>
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-4 mb-8 bg-white p-4 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                <div className="flex items-center gap-4">
                   <div className="w-12 h-12 rounded-full border-2 border-black flex items-center justify-center overflow-hidden bg-white">
                     <img 
                       src={CHARACTERS[targetChar].image} 
                       alt={CHARACTERS[targetChar].name} 
                       className="w-full h-full object-cover"
                       referrerPolicy="no-referrer"
                     />
                   </div>
                   <h2 className="font-black text-2xl tracking-tight">{CHARACTERS[targetChar].name}を聴け！</h2>
                </div>

                <div className="flex items-center gap-6">
                  <div className={`flex items-center gap-2 text-2xl font-black ${timeLeft < 10 ? 'text-red-500 animate-pulse' : ''}`}>
                    <Timer /> {timeLeft}s
                  </div>
                  <button 
                    onClick={handleRepeatPlay}
                    disabled={isPlaying || !hasStarted}
                    className="bg-yellow-400 border-2 border-black p-2 font-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center gap-2 disabled:opacity-50"
                  >
                    <Volume2 size={20}/> もう一度
                  </button>
                </div>
              </div>

              {/* Selection Grid (Desktop) */}
              <div className={`hidden md:grid gap-8 ${(gameMode === 'hard' || gameMode === 'hell') ? 'grid-cols-4' : 'grid-cols-3'}`}>
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-4"><User className="text-blue-500"/> <h3 className="font-black text-xl">だれが</h3></div>
                  {options.who.map(opt => (
                    <Card key={opt.voice} data={opt} icon={User} selected={selections.who === opt.card} onSelect={() => setSelections(s => ({...s, who: opt.card}))} />
                  ))}
                </div>
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-4"><MapPin className="text-red-500"/> <h3 className="font-black text-xl">どこで</h3></div>
                  {options.where.map(opt => (
                    <Card key={opt.voice} data={opt} icon={MapPin} selected={selections.where === opt.card} onSelect={() => setSelections(s => ({...s, where: opt.card}))} />
                  ))}
                </div>
                {(gameMode === 'hard' || gameMode === 'hell') && options.why && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-4"><HelpCircle className="text-purple-500"/> <h3 className="font-black text-xl">なぜ</h3></div>
                    {options.why.map(opt => (
                      <Card key={opt.voice} data={opt} icon={HelpCircle} selected={selections.why === opt.card} onSelect={() => setSelections(s => ({...s, why: opt.card}))} />
                    ))}
                  </div>
                )}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-4"><Activity className="text-green-500"/> <h3 className="font-black text-xl">なにした</h3></div>
                  {options.what.map(opt => (
                    <Card key={opt.voice} data={opt} icon={Activity} selected={selections.what === opt.card} onSelect={() => setSelections(s => ({...s, what: opt.card}))} />
                  ))}
                </div>
              </div>

              {/* Mobile View (Stepper) */}
              <div className="md:hidden">
                <div className="mb-6 flex justify-between px-2">
                   {((gameMode === 'hard' || gameMode === 'hell') ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]).map(i => (
                     <div key={i} className={`h-2 rounded-full border border-black mx-1 flex-1 ${isMobileStep >= i ? 'bg-yellow-400' : 'bg-gray-200'}`} />
                   ))}
                </div>

                <AnimatePresence mode="wait">
                  {isMobileStep === 0 && (
                    <motion.div key="m0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                      <h3 className="font-black text-2xl mb-4 italic">だれが？</h3>
                      <div className="grid grid-cols-2 gap-2 max-w-2xl mx-auto">
                        {options.who.map(opt => <Card key={opt.voice} data={opt} icon={User} selected={selections.who === opt.card} onSelect={() => {setSelections(s => ({...s, who: opt.card})); setIsMobileStep(1);}} />)}
                      </div>
                    </motion.div>
                  )}
                  {isMobileStep === 1 && (
                    <motion.div key="m1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                       <button onClick={() => setIsMobileStep(0)} className="mb-4 font-bold text-gray-500 flex items-center gap-1">← 戻る</button>
                      <h3 className="font-black text-2xl mb-4 italic">どこで？</h3>
                      <div className="grid grid-cols-2 gap-2 max-w-2xl mx-auto">
                        {options.where.map(opt => <Card key={opt.voice} data={opt} icon={MapPin} selected={selections.where === opt.card} onSelect={() => {setSelections(s => ({...s, where: opt.card})); setIsMobileStep((gameMode === 'hard' || gameMode === 'hell') ? 2 : 3);}} />)}
                      </div>
                    </motion.div>
                  )}
                  {isMobileStep === 2 && (gameMode === 'hard' || gameMode === 'hell') && options.why && (
                    <motion.div key="m_why" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                       <button onClick={() => setIsMobileStep(1)} className="mb-4 font-bold text-gray-500 flex items-center gap-1">← 戻る</button>
                      <h3 className="font-black text-2xl mb-4 italic">なぜ？</h3>
                      <div className="grid grid-cols-2 gap-2 max-w-2xl mx-auto">
                        {options.why.map(opt => <Card key={opt.voice} data={opt} icon={HelpCircle} selected={selections.why === opt.card} onSelect={() => {setSelections(s => ({...s, why: opt.card})); setIsMobileStep(3);}} />)}
                      </div>
                    </motion.div>
                  )}
                  {isMobileStep === 3 && (
                    <motion.div key="m2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                       <button onClick={() => setIsMobileStep((gameMode === 'hard' || gameMode === 'hell') ? 2 : 1)} className="mb-4 font-bold text-gray-500 flex items-center gap-1">← 戻る</button>
                      <h3 className="font-black text-2xl mb-4 italic">なにした？</h3>
                      <div className="grid grid-cols-2 gap-2 max-w-2xl mx-auto">
                        {options.what.map(opt => <Card key={opt.voice} data={opt} icon={Activity} selected={selections.what === opt.card} onSelect={() => {setSelections(s => ({...s, what: opt.card})); setIsMobileStep((gameMode === 'hard' || gameMode === 'hell') ? 4 : 3);}} />)}
                      </div>
                    </motion.div>
                  )}
                  {isMobileStep === ((gameMode === 'hard' || gameMode === 'hell') ? 4 : 3) && (
                    <motion.div key="m3" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center p-4 bg-white border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] max-w-xl mx-auto">
                      <h3 className="font-black text-xl mb-4 underline decoration-yellow-400">これでOK？</h3>
                      <div className="grid grid-cols-2 gap-2 text-left font-bold text-sm mb-6 bg-slate-50 p-3 border-2 border-black rounded-xl">
                         <p className="flex items-center gap-1.5"><User size={16} className="text-blue-500 shrink-0"/> <span className="truncate">{selections.who || '---'}</span></p>
                         <p className="flex items-center gap-1.5"><MapPin size={16} className="text-red-500 shrink-0"/> <span className="truncate">{selections.where || '---'}</span></p>
                         {(gameMode === 'hard' || gameMode === 'hell') && <p className="flex items-center gap-1.5"><HelpCircle size={16} className="text-purple-500 shrink-0"/> <span className="truncate">{selections.why || '---'}</span></p>}
                         <p className="flex items-center gap-1.5"><Activity size={16} className="text-green-500 shrink-0"/> <span className="truncate">{selections.what || '---'}</span></p>
                      </div>
                      <div className="flex gap-4">
                        <button onClick={() => setIsMobileStep(0)} className="flex-1 p-3 border-2 border-black font-black">やり直し</button>
                        <button 
                          onClick={() => handleDecide()} 
                          disabled={!selections.who || !selections.where || ((gameMode === 'hard' || gameMode === 'hell') && !selections.why) || !selections.what}
                          className="flex-1 p-3 bg-black text-white font-black hover:bg-gray-800 disabled:opacity-30"
                        >
                          決定！
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Desktop Confirm */}
              <div className="hidden md:flex justify-center mt-12 bg-white p-6 border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                 <div className="flex-1 flex flex-col items-center">
                   <p className="text-sm font-black text-gray-400 uppercase tracking-widest">あなたの答え</p>
                   <div className="flex items-center gap-2 text-2xl font-black mt-2">
                     <span className={selections.who ? 'text-blue-600' : 'text-gray-300'}>{selections.who || '???'}</span>
                     <ChevronRight />
                     <span className={selections.where ? 'text-red-600' : 'text-gray-300'}>{selections.where || '???'}</span>
                     <ChevronRight />
                     {(gameMode === 'hard' || gameMode === 'hell') && (
                       <>
                         <span className={selections.why ? 'text-purple-600' : 'text-gray-300'}>{selections.why || '???'}</span>
                         <ChevronRight />
                       </>
                     )}
                     <span className={selections.what ? 'text-green-600' : 'text-gray-300'}>{selections.what || '???'}</span>
                   </div>
                 </div>
                 <button 
                  onClick={() => handleDecide()}
                  disabled={!selections.who || !selections.where || ((gameMode === 'hard' || gameMode === 'hell') && !selections.why) || !selections.what}
                  className="px-16 py-4 bg-black text-white text-2xl font-black hover:bg-gray-800 transition-colors disabled:opacity-30"
                 >
                   決定！
                 </button>
              </div>
            </div>

            {/* 心の準備オーバーレイ */}
            {!hasStarted && (
              <div className="absolute inset-x-4 inset-y-8 md:inset-8 z-30 flex items-center justify-center p-4">
                <motion.div 
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="bg-white border-4 border-black p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] text-center max-w-md w-full"
                >
                  <div className="w-16 h-16 bg-yellow-400 border-4 border-black rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
                     <Play size={28} className="text-black ml-1" fill="currentColor" />
                  </div>
                  <h3 className="text-2xl font-black mb-2">心の準備はいい？</h3>
                  <p className="text-gray-600 font-bold mb-6">「▶」ボタンを押すと、{(gameMode === 'hell') ? '4' : '3'}人の音声が同時に流れ、{timeLeft}秒の聞き取りがスタートします！</p>
                  
                  <button 
                    onClick={handleStartPlay}
                    className="w-full flex items-center justify-center gap-2 p-5 bg-yellow-400 hover:bg-yellow-300 border-4 border-black font-black text-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-0 hover:translate-x-[4px] hover:translate-y-[4px] transition-all"
                  >
                    <Play size={24} fill="currentColor" /> 聴き取りスタート！
                  </button>
                </motion.div>
              </div>
            )}
          </motion.div>
        )}

        {gameState === 'result' && (
          <motion.div 
            key="result"
            initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center justify-center min-h-screen p-4 text-center max-w-2xl mx-auto"
          >
            <div className={`p-6 mb-4 border-6 md:border-8 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] rotate-[-1deg] ${win ? 'bg-green-400' : 'bg-red-400'}`}>
              {win ? (
                <>
                  <CheckCircle2 size={48} className="mx-auto mb-2" />
                  <h2 className="text-4xl font-black mb-1">正解！</h2>
                  <p className="text-lg font-bold">あなたは聖徳太子の生まれ変わりです。</p>
                </>
              ) : (
                <>
                  <XCircle size={48} className="mx-auto mb-2" />
                  <h2 className="text-4xl font-black mb-1">{timeLeft <= 0 ? 'タイムアップ' : '間違い'}</h2>
                  <p className="text-lg font-bold">修行が足りませんね...</p>
                </>
              )}
            </div>

            <div className="max-w-xl w-full bg-white border-4 border-black p-4 md:p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] mb-4 text-left">
              <div className="flex items-center justify-between mb-3 border-b-2 border-black pb-1.5">
                <h3 className="font-black text-lg">正解の答え</h3>
                <button 
                  onClick={() => playCharSequence(targetAnswers)}
                  disabled={isPlaying}
                  className="flex items-center gap-1.5 px-3 py-1 bg-yellow-400 border-2 border-black font-black text-xs hover:bg-yellow-300 disabled:opacity-50 cursor-pointer"
                >
                  <Volume2 size={14} /> 再生
                </button>
              </div>
              <ul className="space-y-2 font-bold text-base">
                <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-gray-100 pb-1.5">
                  <div className="flex items-center gap-2 text-sm sm:text-base"><User className="text-blue-500 shrink-0" size={18}/> {targetAnswers[0]?.card}</div>
                  {selections.who !== targetAnswers[0]?.card && (
                    <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded self-start sm:self-auto">
                      あなたの答え: {selections.who || '未選択'}
                    </span>
                  )}
                </li>
                <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-gray-100 pb-1.5">
                  <div className="flex items-center gap-2 text-sm sm:text-base"><MapPin className="text-red-500 shrink-0" size={18}/> {targetAnswers[1]?.card}</div>
                  {selections.where !== targetAnswers[1]?.card && (
                    <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded self-start sm:self-auto">
                      あなたの答え: {selections.where || '未選択'}
                    </span>
                  )}
                </li>
                {(gameMode === 'hard' || gameMode === 'hell') ? (
                  <>
                    <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-gray-100 pb-1.5">
                      <div className="flex items-center gap-2 text-sm sm:text-base"><HelpCircle className="text-purple-500 shrink-0" size={18}/> {targetAnswers[2]?.card}</div>
                      {selections.why !== targetAnswers[2]?.card && (
                        <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded self-start sm:self-auto">
                          あなたの答え: {selections.why || '未選択'}
                        </span>
                      )}
                    </li>
                    <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-gray-100 pb-1.5">
                      <div className="flex items-center gap-2 text-sm sm:text-base"><Activity className="text-green-500 shrink-0" size={18}/> {targetAnswers[3]?.card}</div>
                      {selections.what !== targetAnswers[3]?.card && (
                        <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded self-start sm:self-auto">
                          あなたの答え: {selections.what || '未選択'}
                        </span>
                      )}
                    </li>
                  </>
                ) : (
                  <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-gray-100 pb-1.5">
                    <div className="flex items-center gap-2 text-sm sm:text-base"><Activity className="text-green-500 shrink-0" size={18}/> {targetAnswers[2]?.card}</div>
                    {selections.what !== targetAnswers[2]?.card && (
                      <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded self-start sm:self-auto">
                        あなたの答え: {selections.what || '未選択'}
                      </span>
                    )}
                  </li>
                )}
              </ul>
            </div>

            {isChallenge && (
              <div className="mb-4 bg-white border-4 border-black p-3 rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] font-black text-lg">
                獲得スコア: <span className="text-yellow-500 text-xl">+{challengeScores[challengeScores.length - 1] ?? 0}</span> 点 / 10,000点
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              {isChallenge ? (
                currentRound < 3 ? (
                  <button
                    onClick={() => initGame(gameMode, true)}
                    className="px-8 py-4 bg-yellow-400 border-4 border-black text-xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    次のラウンド(Round {currentRound + 1})へ <ArrowRight size={20} />
                  </button>
                ) : (
                  <button
                    onClick={() => setGameState('challengeResult')}
                    className="px-8 py-4 bg-amber-400 border-4 border-black text-xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    最終結果を見る <Trophy size={20} />
                  </button>
                )
              ) : (
                <>
                  <button
                    onClick={() => setGameState('challengeResult')}
                    className="px-8 py-4 bg-amber-400 border-4 border-black text-xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    結果を見る <Trophy size={20} />
                  </button>
                  <button
                    onClick={() => initGame(gameMode)}
                    className="px-8 py-4 bg-yellow-400 border-4 border-black text-xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    もう一度あそぶ <RotateCcw size={20} />
                  </button>
                </>
              )}
              <button
                onClick={() => {
                  setGameState('start');
                  stopAllAudio();
                  setIsChallenge(false);
                }}
                className="px-8 py-4 bg-white border-4 border-black text-xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer"
              >
                タイトルへ
              </button>
            </div>
          </motion.div>
        )}

        {gameState === 'challengeResult' && (
          <motion.div 
            key="challengeResult"
            initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center justify-center min-h-screen p-6 text-center max-w-xl mx-auto"
          >
            {/* 最終得点と称号カード */}
            {(() => {
              const totalScore = challengeScores.reduce((sum, s) => sum + s, 0);
              let title = "修行不足...";
              let colorClass = "from-gray-400 to-slate-500 text-white";
              let titleIcon = XCircle;
              
              if (isChallenge) {
                if (totalScore >= 27000) {
                  title = "聖徳太子の生まれ変わり！";
                  colorClass = "from-yellow-400 to-amber-500 text-black";
                  titleIcon = Crown;
                } else if (totalScore >= 22500) {
                  title = "聖徳太子のソックリさん";
                  colorClass = "from-orange-400 to-yellow-500 text-black";
                  titleIcon = Trophy;
                } else if (totalScore >= 18000) {
                  title = "地獄耳のOL";
                  colorClass = "from-purple-500 to-indigo-600 text-white";
                  titleIcon = Award;
                } else if (totalScore >= 13500) {
                  title = "うわさ好きの友人";
                  colorClass = "from-blue-400 to-teal-500 text-black";
                  titleIcon = User;
                } else if (totalScore >= 9000) {
                  title = "ちょっと疲れた現代人";
                  colorClass = "from-cyan-400 to-blue-500 text-black";
                  titleIcon = Activity;
                } else {
                  title = "耳穴おそうじしましょうね～？";
                  colorClass = "from-amber-200 to-amber-400 text-black";
                  titleIcon = HelpCircle;
                }
              } else {
                if (totalScore >= 9000) {
                  title = "聖徳太子の生まれ変わり";
                  colorClass = "from-yellow-400 to-amber-500 text-black";
                  titleIcon = Crown;
                } else if (totalScore >= 7500) {
                  title = "聖徳太子のソックリさん";
                  colorClass = "from-orange-400 to-yellow-500 text-black";
                  titleIcon = Trophy;
                } else if (totalScore >= 6000) {
                  title = "地獄耳のOL";
                  colorClass = "from-purple-500 to-indigo-600 text-white";
                  titleIcon = Award;
                } else if (totalScore >= 4500) {
                  title = "うわさ好きの友人";
                  colorClass = "from-blue-400 to-teal-500 text-black";
                  titleIcon = User;
                } else if (totalScore >= 3000) {
                  title = "ちょっと疲れた現代人";
                  colorClass = "from-cyan-400 to-blue-500 text-black";
                  titleIcon = Activity;
                } else {
                  title = "耳穴おそうじしましょうね～？";
                  colorClass = "from-amber-200 to-amber-400 text-black";
                  titleIcon = HelpCircle;
                }
              }

              const IconComponent = titleIcon;

              return (
                <>
                  <div className="w-full bg-white border-4 border-black p-8 shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] rounded-2xl mb-8">
                    <p className="text-sm font-black text-gray-400 tracking-wider uppercase mb-1">
                      {isChallenge ? "CHALLENGE COMPLETED" : "GAME COMPLETED"}
                    </p>
                    <h2 className="text-2xl font-black mb-6">
                      {isChallenge ? "チャレンジ最終結果" : "プレイ結果"}
                    </h2>
                    
                    {/* 合計スコア */}
                    <div className="text-5xl font-black tracking-tight mb-6 underline decoration-yellow-400 decoration-8 underline-offset-4">
                      {totalScore.toLocaleString()} <span className="text-xl">点</span>
                    </div>

                    {/* 称号 */}
                    <div className={`p-4 rounded-xl border-4 border-black bg-gradient-to-r ${colorClass} flex items-center justify-center gap-2 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] font-black text-xl mb-6`}>
                      <IconComponent size={24} className="animate-bounce" />
                      <span>{title}</span>
                    </div>

                    {/* ラウンド別スコア内訳 / プレイ情報 */}
                    <div className="bg-gray-50 border-2 border-black rounded-xl p-4 text-left font-bold text-slate-700 space-y-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                      <p className="text-xs font-black text-gray-400 uppercase tracking-wider border-b pb-1 mb-2">
                        {isChallenge ? "得点の内訳" : "プレイ情報"}
                      </p>
                      {isChallenge ? (
                        challengeScores.map((score, i) => (
                          <div key={i} className="flex justify-between items-center text-sm">
                            <span>ラウンド {i + 1}：</span>
                            <span className={`${score > 0 ? 'text-black font-extrabold' : 'text-red-500 font-extrabold'}`}>
                              {score > 0 ? `${score.toLocaleString()} 点` : "0 点 (不正解/タイムアップ)"}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="space-y-1 text-sm">
                          <div className="flex justify-between items-center">
                            <span>スコア：</span>
                            <span className={`${totalScore > 0 ? 'text-black font-extrabold' : 'text-red-500 font-extrabold'}`}>
                              {totalScore > 0 ? `${totalScore.toLocaleString()} 点` : "0 点"}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span>聞き直し回数：</span>
                            <span>{repeatCount} 回</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span>残り時間：</span>
                            <span>{timeLeft} 秒</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 送信フォーム */}
                  {isChallenge && (
                    !hasSubmittedThisGame ? (
                      <div className="w-full bg-white border-4 border-black p-6 shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] rounded-xl mb-8">
                        <h3 className="font-black text-lg mb-2">ランキングにスコアを登録する？</h3>
                        <form onSubmit={handleScoreSubmit} className="space-y-4">
                          <div className="flex gap-2">
                            <div className="flex-1 relative text-left">
                              <input 
                                type="text" 
                                required
                                maxLength={8}
                                value={playerName} 
                                onChange={(e) => {
                                  if (!isAccountRegistered) {
                                    setPlayerName(e.target.value);
                                  }
                                }}
                                disabled={isAccountRegistered}
                                placeholder="名前を入力（8文字まで）"
                                className={`w-full px-4 py-3 border-[3px] border-black font-extrabold focus:outline-none text-lg rounded-lg ${
                                  isAccountRegistered 
                                    ? 'bg-amber-100 text-amber-950 cursor-not-allowed border-dashed pr-24' 
                                    : 'focus:ring-4 focus:ring-yellow-200 bg-white text-black'
                                }`}
                              />
                              {isAccountRegistered && (
                                <span className="absolute top-1/2 -translate-y-1/2 right-3 text-[10px] font-black bg-yellow-400 border-2 border-black text-black px-1.5 py-0.5 rounded shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] uppercase">
                                  🔒 登録済
                                </span>
                              )}
                            </div>
                            <button
                              type="submit"
                              disabled={isSubmitting || !playerName.trim()}
                              className="px-6 py-3 bg-yellow-400 border-[3px] border-black font-black text-lg shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-0 hover:translate-x-[4px] hover:translate-y-[4px] disabled:opacity-50 disabled:pointer-events-none transition-all flex items-center gap-2 rounded-lg text-black"
                            >
                              {isSubmitting ? (
                                <Loader2 className="animate-spin" size={20} />
                              ) : (
                                "登録！"
                              )}
                            </button>
                          </div>
                          <p className="text-xs text-left text-gray-500 font-extrabold leading-tight">
                            {isAccountRegistered 
                              ? "※プロフィール画面で登録した公式ユーザー名で自動送信されます。" 
                              : "※ユーザー名未登録です。アカウント登録（右上のプロフィールボタン）を行うと正式に名前が固定されます。"}
                          </p>
                        </form>
                      </div>
                    ) : (
                      <div className="bg-green-100 border-4 border-black p-4 rounded-xl font-black mb-8 w-full">
                        スコアの送信が完了しました！
                      </div>
                    )
                  )}
                </>
              );
            })()}

            <div className="flex gap-4">
              {!isChallenge && (
                <button
                  onClick={() => initGame(gameMode)}
                  className="px-8 py-4 bg-yellow-400 border-4 border-black font-black text-lg shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] transition-all rounded-lg"
                >
                  もう一度あそぶ
                </button>
              )}
              <button
                onClick={() => {
                  setGameState('start');
                  setIsChallenge(false);
                }}
                className="px-8 py-4 bg-white border-4 border-black font-black text-lg shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] transition-all rounded-lg"
              >
                {isChallenge ? "登録せずにタイトルへ" : "タイトルへ"}
              </button>
            </div>
          </motion.div>
        )}

        {gameState === 'leaderboard' && (
          <motion.div 
            key="leaderboard"
            initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center justify-center min-h-screen p-4 w-full max-w-2xl mx-auto"
          >
            <div className="w-full bg-white border-4 border-black p-6 md:p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] rounded-2xl">
              
              {/* タイトル */}
              <div className="text-center mb-6">
                <Trophy className="mx-auto text-yellow-500 fill-yellow-400 mb-2" size={48} />
                <h2 className="text-3xl font-black italic">ランキング</h2>
                <p className="text-sm font-bold text-gray-400">世界の聴き耳マスター TOP 20</p>
              </div>

              {/* 難易度切り替えタブ */}
              <div className="grid grid-cols-3 gap-2 mb-6 bg-gray-100 p-2 rounded-xl border-2 border-black">
                {(['normal', 'hard', 'hell'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setLeaderboardMode(mode);
                      fetchLeaderboard(mode);
                    }}
                    className={`py-2 font-black rounded-lg text-sm md:text-base border-2 border-transparent transition-all capitalize cursor-pointer ${
                      leaderboardMode === mode 
                        ? 'bg-black text-white border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.3)]' 
                        : 'text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {mode === 'hell' ? '🔥 HELL' : mode === 'hard' ? '👑 HARD' : '⚡ NORMAL'}
                  </button>
                ))}
              </div>

              {/* スコアリスト */}
              {isLoadingLeaderboard ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="animate-spin text-yellow-500" size={40} />
                  <p className="font-bold text-gray-500">ランキングを読み込み中...</p>
                </div>
              ) : leaderboardEntries.length === 0 ? (
                <div className="text-center py-16 text-gray-400 font-bold">
                  まだスコアがありません。最初の挑戦者になりましょう！
                </div>
              ) : (
                <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1 mb-8">
                  {leaderboardEntries.map((entry, index) => {
                    // 順位に応じた色やバッジ
                    let rankClass = "bg-white border-gray-200";
                    let rankIcon = null;
                    if (index === 0) {
                      rankClass = "bg-yellow-100 border-yellow-400 text-yellow-800 font-black";
                      rankIcon = <Crown size={18} className="text-yellow-600 fill-yellow-400 animate-bounce inline" />;
                    } else if (index === 1) {
                      rankClass = "bg-slate-100 border-slate-300 text-slate-800 font-black";
                      rankIcon = <Award size={18} className="text-slate-500 fill-slate-300 inline" />;
                    } else if (index === 2) {
                      rankClass = "bg-amber-100 border-amber-300 text-amber-800 font-black";
                      rankIcon = <Award size={18} className="text-amber-600 fill-amber-300 inline" />;
                    }

                    return (
                      <div 
                        key={entry.id || index}
                        className={`flex items-center justify-between p-3 border-2 rounded-xl transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] hover:shadow-none hover:translate-y-[2px] ${rankClass}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-6 text-center font-black text-lg">
                            {index + 1}
                          </span>
                          <span className="flex items-center gap-1 font-bold text-slate-800">
                            {entry.name} {rankIcon}
                          </span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="font-extrabold text-lg text-black">
                            {entry.score.toLocaleString()} <span className="text-xs font-bold text-gray-500">点</span>
                          </span>
                          <span className="text-xs text-gray-400 font-bold hidden sm:inline">
                            {new Date(entry.createdAt).toLocaleDateString(undefined, {month: '2-digit', day: '2-digit'})}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* あなたのスコア */}
              <div className="bg-gray-50 border-4 border-black rounded-xl p-4 mb-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-left">
                <h3 className="font-extrabold text-sm text-gray-500 mb-2 uppercase tracking-tight">あなたのスコア (自己ベスト)</h3>
                <div className="grid grid-cols-3 gap-2">
                  {(['normal', 'hard', 'hell'] as const).map(mode => {
                    const savedHighScore = localStorage.getItem(`kikimimi_my_highscore_${mode}`);
                    const scoreVal = savedHighScore ? parseInt(savedHighScore, 10) : 0;
                    return (
                      <div key={mode} className="bg-white border-2 border-black p-2 rounded-lg text-center">
                        <span className="block text-xs font-black text-gray-500 uppercase tracking-tighter">
                          {mode === 'hell' ? '🔥 HELL' : mode === 'hard' ? '👑 HARD' : '⚡ NORMAL'}
                        </span>
                        <span className="block font-black text-sm text-black">
                          {scoreVal > 0 ? `${scoreVal.toLocaleString()} 点` : '未挑戦'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* フッター操作 */}
              <div className="flex justify-center border-t-2 border-gray-100 pt-6">
                <button
                  onClick={() => {
                    setGameState('start');
                    setIsChallenge(false);
                  }}
                  className="px-10 py-4 bg-black hover:bg-gray-800 text-white font-black text-xl shadow-[4px_4px_0px_0px_rgba(33,33,33,0.3)] transition-colors rounded-xl cursor-pointer"
                >
                  タイトルへ戻る
                </button>
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>



      <div className="fixed inset-0 pointer-events-none z-[-1] overflow-hidden opacity-5">
        <h1 className="text-[20vw] font-black absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-12 whitespace-nowrap">
          KIKIMIMI KIKIMIMI KIKIMIMI
        </h1>
      </div>
    </div>
  );
}
