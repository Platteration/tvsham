/**
 * The website's account and shop as the screens see them: whether api/ answered, who is signed
 * in, which accents the shop sells and which of them the visitor owns, and the one line the page
 * says about it. Built over whichever account client the platform resolves (account-client.ts on
 * a phone, which answers "not configured" at once, so nothing here changes the phone apps), and
 * free of React Native, so a plain test drives it with a client of its own.
 *
 * The server is the record of a purchase: an accent the shop sells is drawn only when `GET api/me`
 * says it is owned. Before api/ has answered, only Midnight is drawn, as before the settings are
 * read; on a site where api/ does not answer, the settings record's own list stands, as it always
 * did.
 */
import { useSyncExternalStore } from "react";
import { accountClient } from "./account-client";
import {
  ACCOUNT_NOTES,
  SIGNED_OUT,
  canUseAccent,
  drawnAccent,
  ownedAccents,
  pollFor,
  type AccentAccess,
  type AccentProduct,
  type AccountClient,
  type ApiConfig,
  type Me,
} from "./account-model";
import type { AccentName } from "./palette";

/** The one line the page says about the account, until it is dismissed. */
export type AccountNotice =
  | { kind: "signInFailed" }
  | { kind: "thanks"; name: string }
  | { kind: "pending" }
  | { kind: "error"; text: string };

export interface AccountState {
  /** `asking`: api/ asked, no answer yet. `off`: no account in this build or on this site. `on`: sign-in, and the shop if `config.products` lists anything. */
  phase: "asking" | "off" | "on";
  config: ApiConfig | null;
  me: Me;
  /** A Buy, a sign-out or a deletion in flight. */
  busy: boolean;
  notice: AccountNotice | null;
}

export interface AccountStore {
  get(): AccountState;
  subscribe(listener: () => void): () => void;
  /** Asks api/ once, and reads what the address said on arrival; later calls return the same promise. */
  start(): Promise<void>;
  /** Which accents may be drawn and chosen now. */
  access(): AccentAccess;
  signIn(): void;
  signOut(): Promise<void>;
  /** Deletes the account. The screen confirms first (confirm.ts). */
  deleteAccount(): Promise<void>;
  /** Buy: a sign-in when signed out, else Checkout. */
  buy(product: AccentProduct): Promise<void>;
  dismiss(): void;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function createAccountStore(client: AccountClient, wait: (ms: number) => Promise<void> = sleep): AccountStore {
  let state: AccountState = { phase: client.web ? "asking" : "off", config: null, me: SIGNED_OUT, busy: false, notice: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let started: Promise<void> | null = null;

  /** Back from Checkout: wait for the webhook's grant, then thank for the pack by name. */
  const thank = async (config: ApiConfig, before: Me) => {
    const pending = client.takePending();
    const bought = config.products.find((p) => p.id === pending) ?? null;
    const had = new Set(before.entitlements);
    // The pack this tab sent to Checkout; with no record of it, any pack the account did not own.
    const arrived = (me: Me) =>
      bought ? (me.entitlements.includes(bought.id) ? bought : null) : (config.products.find((p) => me.entitlements.includes(p.id) && !had.has(p.id)) ?? null);
    const already = bought && before.entitlements.includes(bought.id) ? bought : null;
    if (already) {
      set({ notice: { kind: "thanks", name: already.name } });
      return;
    }
    const { held, me } = await pollFor((m) => arrived(m) !== null, () => client.me(), wait, (m) => set({ me: m }));
    const product = held && me ? arrived(me) : null;
    set({ notice: product ? { kind: "thanks", name: product.name } : { kind: "pending" } });
  };

  const store: AccountStore = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      started ??= (async () => {
        if (!client.web) return;
        const landing = client.takeLanding();
        const config = await client.config();
        if (!config) {
          set({ phase: "off" });
          return;
        }
        const me = (await client.me()) ?? SIGNED_OUT;
        set({ phase: "on", config, me, notice: landing.signIn === "failed" ? { kind: "signInFailed" } : null });
        if (landing.purchase === "success") await thank(config, me);
        else if (landing.purchase === "cancelled") client.takePending();
      })();
      return started;
    },
    access() {
      if (state.phase === "asking") return { kind: "asking" };
      if (state.phase === "off" || !state.config || state.config.products.length === 0) return { kind: "stored" };
      return { kind: "shop", sold: new Set<AccentName>(state.config.products.map((p) => p.accent)), owned: ownedAccents(state.me) };
    },
    signIn() {
      if (state.phase === "on") client.signIn();
    },
    async signOut() {
      set({ busy: true });
      const ok = await client.signOut();
      set(ok ? { busy: false, me: SIGNED_OUT, notice: null } : { busy: false, notice: { kind: "error", text: ACCOUNT_NOTES.signOutFailed } });
    },
    async deleteAccount() {
      set({ busy: true });
      const ok = await client.deleteAccount();
      set(ok ? { busy: false, me: SIGNED_OUT, notice: null } : { busy: false, notice: { kind: "error", text: ACCOUNT_NOTES.deleteFailed } });
    },
    async buy(product) {
      if (state.phase !== "on") return;
      if (!state.me.user) {
        client.signIn();
        return;
      }
      set({ busy: true, notice: null });
      const result = await client.checkout(product.id);
      switch (result) {
        case "redirecting":
          return; // the page is on its way to Checkout
        case "signin":
          // The session ended on the server: the page says Sign in to buy again.
          set({ busy: false, me: SIGNED_OUT });
          return;
        case "owned":
          set({ busy: false, me: (await client.me()) ?? state.me });
          return;
        case "unavailable":
          set({ busy: false, notice: { kind: "error", text: ACCOUNT_NOTES.unavailable } });
          return;
        case "busy":
          set({ busy: false, notice: { kind: "error", text: ACCOUNT_NOTES.busy } });
          return;
        case "failed":
          set({ busy: false, notice: { kind: "error", text: ACCOUNT_NOTES.failed } });
          return;
      }
    },
    dismiss() {
      set({ notice: null });
    },
  };
  return store;
}

/** The app's one account store, over the client this platform resolves. */
export const account = createAccountStore(accountClient);

export function useAccount(): AccountState {
  return useSyncExternalStore(account.subscribe, account.get, account.get);
}

/** Whether `name` may be chosen, given the settings record's own list. */
export function useCanUseAccent(unlocked: readonly AccentName[]): (name: AccentName) => boolean {
  useAccount();
  const access = account.access();
  return (name) => canUseAccent(access, unlocked, name);
}

/** The accent the app draws with now. */
export function useDrawnAccent(chosen: AccentName): AccentName {
  useAccount();
  return drawnAccent(account.access(), chosen);
}
