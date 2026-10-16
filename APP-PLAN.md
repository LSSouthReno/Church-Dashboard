# A Living Stones app for every member — plan

*October 16, 2026. Written for Brad. Covers My Journey plus the dashboard.*

## Recommendation

Start with the **installable web app (PWA)**. Make it the "Living Stones" app that opens on **My Journey**.
It costs nothing, needs no app store and no review, and it is already working on beta.

Add **Google Play through PWABuilder** once people are using it ($25, low risk).

Leave the **Apple App Store** until the app does things a website can't, like real push reminders. Then wrap it with **Capacitor**.

You don't have to choose now. Each step reuses the same pages, so nothing gets rewritten.

| | (a) Installable web app (PWA) | (b) Capacitor wrapper → App Store + Google Play | (c) PWABuilder packages |
|---|---|---|---|
| **What it is** | "Add to Home Screen" from lssouthreno.com/journey/. Has its own icon and opens full-screen. | A real store app: the same pages inside a native shell, plus native plugins (push, Face ID, share sheet). | A free tool (pwabuilder.com) that wraps the live site. Android gets a Trusted Web Activity for Google Play. iOS gets an Xcode project, which is a thin wrapper. |
| **Cost** | $0 | Apple $99/yr ([fee waiver possible for US nonprofits](https://developer.apple.com/support/membership-fee-waiver/)). Google $25 once. Plus a few hours per release. | Google $25 once. Apple $99/yr if you also do iOS. |
| **Apple review risk** | None, because Apple doesn't review it | **Medium to high** at first. Guideline 4.2 rejects apps that are "just a website", and reviewers check Airplane Mode. It passes if it has native push, an offline screen, and native sharing. | Android: low (Play accepts TWAs). iOS: **high**, because it's the bare wrapper Apple rejects. |
| **Push nudges ("For you", reminders)** | Yes, through Web Push. Android: works. iPhone: iOS 16.4+, and only after the app is on the home screen and the person taps "Allow". | Yes, native push. Most reliable on both, and shows up like any app. | Android: Web Push through Chrome works. iOS: same as Capacitor once you add a push plugin. |
| **Stays signed in** | 90-day token in `localStorage` (`lssr_journey_token`). The installed app on iPhone keeps **its own** storage, so people **sign in once more inside the app** (the card says so). Home-screen apps are exempt from Safari's 7-day storage wipe. | Same token, kept by the app. Use the texted code typed into the app. Emailed links open the browser. | Same as (a) on Android. |
| **Updates** | Instant. Every visit gets the newest page. | Page changes are instant. Native changes (icon, plugins) need a new store release. | Instant (it loads the live site). |
| **Found in the stores** | No. Share by link, QR code, or the Sunday slide. | Yes, both stores | Google Play (and iOS if it passes) |
| **What Brad must do** | Nothing extra | Apple Developer org account: needs a **D-U-N-S number** (free, ~1–2 weeks), the church EIN, a Mac with Xcode, and **a test login for Apple's reviewer** (our sign-in is a texted code). Google Play org account (also D-U-N-S). Privacy policy page. | Google Play org account. Upload the file PWABuilder makes. Add one verification file to the site (`/.well-known/assetlinks.json`). |

**Why this order**

- Most members will install from a link or QR code anyway.
- (a) reaches every iPhone and Android **today**.
- (c)-Android adds a Play Store listing for $25 with almost no risk of rejection.
- (b)-iOS is the only path with a real chance of rejection. It's also the only one that needs yearly upkeep, so it should wait until it has native push to justify itself.

**Google Play account type**

Register as an **organization**. New *personal* accounts must first run a 14-day closed test with 12 testers. Organization accounts reportedly skip that.

## Push notifications (the "For you" nudges): how we'd do it

Apps Script can't sign Web Push messages itself, but it **can** call **Firebase Cloud Messaging**, which is free:

1. The app asks "Turn on reminders?" **after** a person taps a button. Never on first open: iPhone requires the tap, and asking at the right moment gets more yeses.
2. The browser gives back a device token, and the app saves it with `jr_*` → Code_journey.gs → a `PushTokens` sheet.
3. A time trigger, like the existing ones, picks who gets which nudge. Some examples:
   - "Your group meets tonight"
   - "You're serving Sunday"
   - "Baptism class is next week"
   - a new "For you" step
4. It sends the message through FCM's HTTP API, using a Google service-account key that Apps Script signs (RS256 is supported).
5. The same FCM setup later serves the Capacitor app too, so nothing is wasted.

**What Brad must do:** create a free Firebase project, and approve one new backend deploy. Backend changes don't go through beta.

**Rule of thumb:** at most 1–2 nudges a week per person, and every one leads to a next step.

## What changed on beta (staging) in this step

**Two apps on one site**

| | Staff app | Member app |
|---|---|---|
| Name | "LS Dashboard" | **"Living Stones"** (new) |
| Manifest | `/manifest.webmanifest` | `/journey/manifest.webmanifest` |
| Opens on | `/?source=app` | `/journey/?source=app` |
| Identity | `id` is pinned to `/?source=app`, the value Chrome already used, so existing installs stay the same app | `id: "/journey/"`, so it never collides with the staff app |
| Install prompt | the existing one on the dashboard | a new one on My Journey (below) |

- **Install from My Journey:** you get the member app. **Install from the dashboard:** you get the staff app.

**The `start_url` / `scope` decision**

- The member app's `start_url` is `/journey/?source=app`, so it opens straight on My Journey.
- Its `scope` is **`/`**, not `/journey/`, so the whole site stays inside the app. Staff who install the member app can still tap **Dashboard** (top right) and stay in the app. A long-press on the icon (Android) also offers **Staff dashboard** as a shortcut.
  - With `/journey/` as the scope, every Dashboard tap would open a browser sheet instead.
- `?source=app` lets us count app opens later.

**Get the app card on My Journey (phones only, after sign-in)**

- **Android:** the card's **Add to Home Screen** button opens Chrome's real install prompt.
- **iPhone:** it shows **Share → Add to Home Screen** steps and says you'll sign in once more in the app.
- The card is hidden in these cases:
  - inside the app
  - in pastor preview
  - when My Journey is embedded in the dashboard
  - for 30 days after **Not now**
- My Journey now registers the site's service worker, so it can be installed and opens offline. The cache was bumped to `lssr-app-v4`, and `/journey/` is pre-saved.
- **Inside the installed app**, the "check your email" sign-in step says to **type the code**, because the email's button opens the browser instead of the app.

**Soft colors**

- Both manifests, and the `theme-color` meta on index, journey and fit, now use **#f5f3ee**. That gives a light top bar and splash screen.
- `theme.js` switches the bar back to #141414 for anyone on Classic.
- The iPhone status bar style on the dashboard is now `default` (dark text on light) instead of `black`.

**Unchanged:** the icons in `assets/app/` (white LS on dark). They look right on both light and dark home screens, and the maskable version stays inside Android's safe zone.

## Next steps (in order)

1. **Brad:** try it on beta. On a phone, open https://lssouthreno.github.io/journey/, sign in, and add it to your home screen. Then ship with `scripts/ship.sh` when you're happy.
   - Beta and live are different addresses, so the home-screen app you install on beta is a separate "beta" app.
2. Put a QR code and the link `lssouthreno.com/journey` on the Sunday slides or the welcome card.
3. Turn on push reminders (Firebase + backend; see above).
4. Google Play listing through PWABuilder. Needs: an organization developer account, `assetlinks.json`, and a privacy-policy page.
5. App Store through Capacitor, once push works. Start the D-U-N-S request early because it is the slowest step.

**Things to test on real phones before step 4 or 5**

- **"Sign in with Planning Center" inside the installed iPhone app.** The trip out to PCO and back can land in a browser sheet instead of the app. The texted code always works.
- **Offline open.** Put the phone in Airplane Mode and open the app. It should open the app and say it can't reach the server. It should not show the browser's offline error page. Your details still need a connection. Before the App Store, show the last saved journey offline instead, because Apple's reviewers test this.
