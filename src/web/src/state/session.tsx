import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { BootstrapData, Cap, Customer, UserInfo } from '../api/types';
import {
  flushOutbox,
  loadSnapshot,
  pendingBalanceDeltas,
  pendingCapUsage,
  pendingCount,
  saveSnapshot,
  startOutboxSync,
} from '../db/outbox';

interface SessionState {
  user: UserInfo | null;
  data: BootstrapData | null;
  /** Customers with outbox deltas applied, so balances are right while offline. */
  customers: Customer[];
  /** Cap colours with queued usage already deducted. */
  caps: Cap[];
  /** When the cap counts were last confirmed with the server (epoch ms). */
  capsAsOf: number | null;
  capsRefreshing: boolean;
  /** Pull cap counts now, without waiting for the 15s timer. */
  refreshCaps: () => Promise<void>;
  loading: boolean;
  online: boolean;
  queued: number;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Recompute local balances after a sale, without a server round-trip. */
  applyLocalSale: (customerId: number, balanceDelta: number) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [deltas, setDeltas] = useState<Map<number, number>>(new Map());
  const [capUsage, setCapUsage] = useState<Map<number, number>>(new Map());
  const [liveCaps, setLiveCaps] = useState<Cap[] | null>(null);
  const [capsAsOf, setCapsAsOf] = useState<number | null>(null);
  const [capsRefreshing, setCapsRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [queued, setQueued] = useState(0);

  const refreshQueueState = useCallback(async () => {
    setQueued(await pendingCount());
    setDeltas(await pendingBalanceDeltas());
    setCapUsage(await pendingCapUsage());
  }, []);

  /**
   * Pull just the cap counts. Three rows, so it can run far more often than the
   * full snapshot. Also exposed to the UI as a manual "Refresh" so the operator
   * never has to wait on a timer to settle a doubt.
   */
  const refreshCaps = useCallback(async () => {
    setCapsRefreshing(true);
    try {
      const rows = await api.get<Array<{ productId: number; code: string; name: string; onHand: number }>>(
        '/api/stock/caps',
      );
      setLiveCaps(rows.map((r) => ({ id: r.productId, code: r.code, name: r.name, onHand: r.onHand })));
      setCapsAsOf(Date.now());
    } catch {
      // Offline or a blip. Keep whatever is on screen; the timestamp stops
      // advancing, which is exactly the signal the operator needs.
    } finally {
      setCapsRefreshing(false);
    }
    await refreshQueueState();
  }, [refreshQueueState]);

  const loadBootstrap = useCallback(async () => {
    try {
      const fresh = await api.get<BootstrapData>('/api/bootstrap');
      setData(fresh);
      await saveSnapshot(fresh);
    } catch (error) {
      // Offline, or the server is down. Fall back to the cached snapshot so the
      // till still opens and can keep selling.
      const cached = await loadSnapshot();
      if (cached) setData(cached);
      else if (!(error instanceof ApiError && error.isOffline)) throw error;
    }
    await refreshQueueState();
  }, [refreshQueueState]);

  // Restore an existing session on load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.get<UserInfo>('/api/auth/me');
        if (cancelled) return;
        setUser(me);
        await loadBootstrap();
      } catch {
        // 401, or unreachable. Either way the login screen is correct.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBootstrap]);

  // Connectivity indicator for the header.
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Background outbox sync while signed in.
  useEffect(() => {
    if (!user) return;
    return startOutboxSync(async (result) => {
      // ORDER MATTERS. A synced sale is accounted for in exactly one of two
      // places: the local outbox deduction, or the server snapshot. Clearing
      // the deduction before the new snapshot arrives leaves a window where
      // NEITHER accounts for it, and the on-screen count visibly jumps back up
      // before settling - which reads as the number being wrong.
      //
      // loadBootstrap() refreshes the queue state itself, as its last step, so
      // awaiting it hands over from one source to the other with no gap.
      if (result.accepted > 0) await loadBootstrap();
      else await refreshQueueState();
    });
  }, [user, refreshQueueState, loadBootstrap]);

  // Periodic full snapshot refresh: customers, rates, balances.
  //
  // These change rarely and a minute of staleness is harmless, so the ~15 KB
  // payload runs on a slow timer. It never touches the sale path.
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      if (navigator.onLine) void loadBootstrap();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [user, loadBootstrap]);

  // Fast cap-stock poll, on its own short timer.
  //
  // Caps move constantly from both ends - the counter draws them down and an
  // administrator tops them up - so a minute of staleness is genuinely
  // confusing here in a way it is not for a customer's phone number. This hits
  // a three-row endpoint rather than the full snapshot, so 15s costs a few
  // hundred bytes.
  useEffect(() => {
    if (!user) return;
    void refreshCaps();
    const timer = window.setInterval(() => {
      if (navigator.onLine) void refreshCaps();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [user, refreshCaps]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const me = await api.post<UserInfo>('/api/auth/login', { username, password });
      setUser(me);
      await loadBootstrap();
    },
    [loadBootstrap],
  );

  const signOut = useCallback(async () => {
    // Do not strand queued sales on this device: try once to flush before the
    // session cookie goes away.
    await flushOutbox().catch(() => undefined);
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setData(null);
  }, []);

  const applyLocalSale = useCallback((customerId: number, balanceDelta: number) => {
    setDeltas((previous) => {
      const next = new Map(previous);
      next.set(customerId, (next.get(customerId) ?? 0) + balanceDelta);
      return next;
    });
    void pendingCount().then(setQueued);
  }, []);

  const customers = useMemo(() => {
    if (!data) return [];
    if (deltas.size === 0) return data.customers;
    return data.customers.map((customer) =>
      deltas.has(customer.id)
        ? { ...customer, balance: customer.balance + (deltas.get(customer.id) ?? 0) }
        : customer,
    );
  }, [data, deltas]);

  const caps = useMemo(() => {
    // The fast poll wins over the snapshot when it has run; the snapshot is the
    // fallback so the till still shows counts offline or before the first poll.
    const base = liveCaps ?? data?.caps ?? [];
    if (capUsage.size === 0) return base;
    // Queued-but-unsynced sales are still deducted on top, so the figure stays
    // honest while the outbox drains.
    return base.map((cap) =>
      capUsage.has(cap.id) ? { ...cap, onHand: cap.onHand - (capUsage.get(cap.id) ?? 0) } : cap,
    );
  }, [liveCaps, data, capUsage]);

  const value = useMemo<SessionState>(
    () => ({
      user,
      data,
      customers,
      caps,
      capsAsOf,
      capsRefreshing,
      refreshCaps,
      loading,
      online,
      queued,
      signIn,
      signOut,
      refresh: loadBootstrap,
      applyLocalSale,
    }),
    [user, data, customers, caps, capsAsOf, capsRefreshing, refreshCaps, loading, online, queued,
     signIn, signOut, loadBootstrap, applyLocalSale],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider.');
  return context;
}

/** The bootstrap payload, for screens that only render once it exists. */
export function useBootstrap(): BootstrapData {
  const { data } = useSession();
  if (!data) throw new Error('Bootstrap data is not loaded yet.');
  return data;
}
