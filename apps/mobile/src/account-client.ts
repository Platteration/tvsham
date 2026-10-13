/**
 * The account and the shop on a phone: not configured. The website's sign-in and accent packs are
 * its own (account-client.web.ts, which Metro bundles into the web build alone, and only there
 * resolves for this name); the phone apps keep every accent they have, as they always did, and
 * sell nothing, since the App Store and Google Play require their own in-app purchase for it. So
 * this twin answers everything with "nothing here" and opens nothing: account-model.test.ts holds
 * it to that, and to being the module a native build resolves.
 */
import { NO_LANDING, type AccountClient } from "./account-model";

export const accountClient: AccountClient = {
  web: false,
  config: async () => null,
  me: async () => null,
  signIn: () => {},
  signOut: async () => false,
  deleteAccount: async () => false,
  checkout: async () => "unavailable",
  takeLanding: () => NO_LANDING,
  takePending: () => null,
};
