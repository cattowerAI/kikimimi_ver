import { initializeApp, getApp, getApps } from 'firebase/app';
import { 
  getFirestore, collection, addDoc, getDocs, query, where, orderBy, 
  limit, serverTimestamp, doc, getDocFromServer, onSnapshot, setDoc, 
  updateDoc, deleteDoc, getDoc, runTransaction 
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

// Define error helper types as required by skill guidelines
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

// Check configuration
let firebaseConfig: any = null;
try {
  // Use relative path or standard alias to look up
  firebaseConfig = require('../firebase-applet-config.json');
} catch (e) {
  // Fallback if require doesn't work in client code (or standard dynamic import)
}

// In client-side Vite/ESM environment, we can also import it or use a default
import fallbackConfig from '../firebase-applet-config.json';
const config = firebaseConfig || fallbackConfig;

const isDummy = !config || config.apiKey === 'dummy-api-key' || config.projectId === 'dummy-project';

let app: any = null;
let db: any = null;
let auth: any = null;

if (!isDummy) {
  try {
    app = getApps().length === 0 ? initializeApp(config) : getApp();
    db = getFirestore(app, config.firestoreDatabaseId);
    auth = getAuth(app);
    
    // Validate connection asynchronously as specified in guidelines
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();
  } catch (error) {
    console.warn("Firebase initialization failed, dynamic fallback activated:", error);
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo: auth?.currentUser?.providerData?.map((provider: any) => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Local Storage definitions for offline/pre-setup fallback
export interface LeaderboardEntry {
  id?: string;
  name: string;
  score: number;
  mode: 'normal' | 'hard' | 'hell';
  createdAt: any; // Date string or Timestamp
}

const getLocalRankings = (mode: 'normal' | 'hard' | 'hell'): LeaderboardEntry[] => {
  try {
    const rawData = localStorage.getItem(`kikimimi_ranking_${mode}`);
    if (rawData) {
      const parsed = JSON.parse(rawData);
      return parsed.map((item: any) => ({
        ...item,
        createdAt: new Date(item.createdAt)
      }));
    }
  } catch (e) {
    console.error("Failed to read local rankings", e);
  }
  // Load initially dummy data if empty to make it look full and polished!
  const defaultList: LeaderboardEntry[] = [
    { name: "SHOTOKU", score: 28500, mode, createdAt: new Date() },
    { name: "KIKIMIMI", score: 25000, mode, createdAt: new Date() },
    { name: "TAMAGO", score: 18000, mode, createdAt: new Date() },
    { name: "GUEST_A", score: 12000, mode, createdAt: new Date() },
    { name: "GUEST_B", score: 8500, mode, createdAt: new Date() },
  ];
  return defaultList.sort((a, b) => b.score - a.score);
};

const saveLocalRankings = (mode: 'normal' | 'hard' | 'hell', list: LeaderboardEntry[]) => {
  try {
    localStorage.setItem(`kikimimi_ranking_${mode}`, JSON.stringify(list));
  } catch (e) {
    console.error("Failed to save local rankings", e);
  }
};

/**
 * Submits a leaderboard score. Automatically switches between Firestore and LocalStorage.
 */
export async function submitScore(name: string, score: number, mode: 'normal' | 'hard' | 'hell'): Promise<void> {
  const sanitizedName = name.trim().slice(0, 8);
  if (!sanitizedName) return;

  if (isDummy || !db) {
    // Local storage submit
    const currentList = getLocalRankings(mode);
    const newEntry: LeaderboardEntry = {
      id: Math.random().toString(36).substring(2, 9),
      name: sanitizedName,
      score,
      mode,
      createdAt: new Date(),
    };
    const updatedList = [...currentList, newEntry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20); // Top 20 only
    saveLocalRankings(mode, updatedList);
    return;
  }

  // Firestore submit
  const path = 'rankings';
  try {
    const ref = collection(db, path);
    await addDoc(ref, {
      name: sanitizedName,
      score: score,
      mode: mode,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Retrieves top 20 leaderboard entries. Automatically switches between Firestore and LocalStorage.
 */
export async function getLeaderboard(mode: 'normal' | 'hard' | 'hell'): Promise<LeaderboardEntry[]> {
  if (isDummy || !db) {
    return getLocalRankings(mode);
  }

  const path = 'rankings';
  try {
    const rankingCollectionRef = collection(db, path);
    const q = query(
      rankingCollectionRef,
      where('mode', '==', mode),
      orderBy('score', 'desc'),
      limit(20)
    );
    const snap = await getDocs(q);
    const entries: LeaderboardEntry[] = [];
    snap.forEach((doc) => {
      const data = doc.data();
      entries.push({
        id: doc.id,
        name: data.name || '???',
        score: data.score || 0,
        mode: data.mode || mode,
        createdAt: data.createdAt?.toDate() || new Date()
      });
    });
    return entries;
  } catch (error) {
    // If indices are still building or connection is bad, fallback transparently to local storage
    console.warn("Firestore query failed, using local fallback", error);
    return getLocalRankings(mode);
  }
}

export { db, auth, isDummy, handleFirestoreError };

/**
 * Anonymously logs in and returns the UID.
 */
export async function loginAnonymously(): Promise<string> {
  if (isDummy || !auth) {
    let localId = localStorage.getItem('kikimimi_local_uid');
    if (!localId) {
      localId = 'player_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('kikimimi_local_uid', localId);
    }
    return localId;
  }
  try {
    const userCredential = await signInAnonymously(auth);
    return userCredential.user.uid;
  } catch (error) {
    console.warn("Anonymous login failed, using local temporary UID fallback:", error);
    let localId = localStorage.getItem('kikimimi_local_uid');
    if (!localId) {
      localId = 'player_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('kikimimi_local_uid', localId);
    }
    return localId;
  }
}
