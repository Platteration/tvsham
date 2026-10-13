/**
 * The website's account and shop on screen: the line the page says on the way back from Google or
 * Stripe, the Account card and the accent packs. Each draws nothing unless the site's api/ said
 * sign-in is on (account.ts), which a phone's client never does, so none of this is ever drawn in
 * the phone apps or on a site with no api/. Everything the server said is drawn as text.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Platform, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { account, useAccount, type AccountNotice as Notice } from "./account";
import { ACCOUNT_NOTES, WORDS, formatPrice, type AccentProduct } from "./account-model";
import { confirmAction } from "./confirm";
import { ACCENTS, makeStyles, space, useTheme, type Palette } from "./theme";
import { Button, Card, Muted, Title } from "./ui";

function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case "signInFailed":
      return WORDS.signInFailed;
    case "thanks":
      return WORDS.thanks(notice.name);
    case "pending":
      return WORDS.paymentPending;
    case "error":
      return notice.text;
  }
}

function noticeColor(notice: Notice, c: Palette): string {
  switch (notice.kind) {
    case "thanks":
      return c.success;
    case "error":
      return c.danger;
    default:
      return c.warning;
  }
}

/** The line the page says about the account, with Dismiss; nothing when there is nothing to say. */
export function AccountNotice({ style }: { style?: StyleProp<ViewStyle> }) {
  const { notice } = useAccount();
  const c = useTheme();
  const styles = useStyles();
  if (!notice) return null;
  return (
    <Card style={[styles.notice, style]}>
      <View accessibilityRole="alert" style={{ flex: 1 }}>
        <Text style={[styles.noticeText, { color: noticeColor(notice, c) }]}>{noticeText(notice)}</Text>
      </View>
      <Button label={WORDS.dismiss} variant="ghost" compact onPress={() => account.dismiss()} />
    </Card>
  );
}

/**
 * Takes the kit's answer (`?signin=failed`, `?purchase=success|cancelled`) out of the address on
 * the first screen, where the kit and Checkout send the visitor back, and leaves every other
 * parameter. Through the router: Expo Router writes the address from its own state, so the
 * client's history.replaceState (account-client.web.ts) is written over when the router mounts,
 * and again on every navigation back to this screen (measured in Chromium: ?purchase=success came
 * back). The router is not ready on the very first frame, when setParams throws; it is asked
 * again a moment later.
 */
export function useLandingCleared(): void {
  const { signin, purchase } = useLocalSearchParams<{ signin?: string; purchase?: string }>();
  const failed = signin === "failed";
  const returned = purchase === "success" || purchase === "cancelled";
  useEffect(() => {
    if (Platform.OS !== "web" || (!failed && !returned)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = (tries: number) => {
      try {
        router.setParams({ ...(failed ? { signin: undefined } : {}), ...(returned ? { purchase: undefined } : {}) });
      } catch {
        if (tries > 0) timer = setTimeout(() => clear(tries - 1), 50);
      }
    };
    clear(40);
    return () => clearTimeout(timer);
  }, [failed, returned]);
}

/** Sign in with Google, or who is signed in with Sign out and Delete account. */
export function AccountCard() {
  const { phase, me, busy } = useAccount();
  const styles = useStyles();
  if (phase !== "on") return null;
  const deleteAccount = () =>
    confirmAction({
      title: ACCOUNT_NOTES.deleteTitle,
      message: ACCOUNT_NOTES.deleteBody,
      cancelLabel: ACCOUNT_NOTES.deleteCancel,
      confirmLabel: ACCOUNT_NOTES.deleteConfirm,
      onConfirm: () => void account.deleteAccount(),
    });
  return (
    <Card>
      <Title>{WORDS.section}</Title>
      {me.user ? (
        <>
          <Muted style={{ marginTop: space.xs }}>{me.user.email ? WORDS.signedInAs(me.user.email) : WORDS.signedIn}</Muted>
          <View style={styles.row}>
            <Button label={WORDS.signOut} variant="secondary" compact disabled={busy} onPress={() => void account.signOut()} />
            <Button label={WORDS.deleteAccount} variant="ghost" compact disabled={busy} onPress={deleteAccount} />
          </View>
        </>
      ) : (
        <Button label={WORDS.signIn} variant="secondary" style={{ marginTop: space.md }} onPress={() => account.signIn()} />
      )}
    </Card>
  );
}

/** The accent packs on sale: each with its price, and Buy, Sign in to buy or Owned. */
export function AccentShopCard() {
  const { phase, config, me, busy } = useAccount();
  if (phase !== "on" || !config || config.products.length === 0) return null;
  const owned = new Set(me.entitlements);
  return (
    <Card>
      <Title>{ACCOUNT_NOTES.shopTitle}</Title>
      <Muted style={{ marginTop: space.xs }}>{ACCOUNT_NOTES.shopIntro}</Muted>
      {config.products.map((product) => (
        <ShopRow key={product.id} product={product} owned={owned.has(product.id)} signedIn={me.user !== null} busy={busy} />
      ))}
    </Card>
  );
}

function ShopRow({ product, owned, signedIn, busy }: { product: AccentProduct; owned: boolean; signedIn: boolean; busy: boolean }) {
  const styles = useStyles();
  const price = product.price ? formatPrice(product.price) : null;
  return (
    <View style={styles.product}>
      <View style={[styles.dot, { backgroundColor: ACCENTS[product.accent].accent }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.productName}>{product.name}</Text>
        <Muted>{product.description}</Muted>
        {price ? <Text style={styles.price}>{price}</Text> : null}
      </View>
      {owned ? (
        <Muted accessibilityLabel={`${product.name}: ${WORDS.owned}`}>{WORDS.owned}</Muted>
      ) : (
        <Button
          label={signedIn ? WORDS.buy : WORDS.signInToBuy}
          compact
          disabled={busy}
          accessibilityLabel={`${signedIn ? WORDS.buy : WORDS.signInToBuy}: ${product.name}`}
          onPress={() => void account.buy(product)}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  notice: { flexDirection: "row", alignItems: "center", gap: space.md },
  noticeText: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  product: { flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.lg },
  dot: { width: 26, height: 26, borderRadius: 13 },
  productName: { color: c.text, fontSize: 16, fontWeight: "600" },
  price: { color: c.text, fontSize: 14, fontWeight: "600", marginTop: 2 },
}));
