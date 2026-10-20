# Setting up Supabase (where your logs are saved)

You only do this once. It takes about 10 minutes.

## 1. Create the project
1. Go to <https://supabase.com> and click **Start your project**.
   Sign up. "Continue with GitHub" is easiest, since you already have GitHub.
2. Click **New project** and fill in:
   - **Name:** `workout-tracker`
   - **Database password:** click **Generate a password** and save it somewhere safe.
     (The tracker doesn't use it, but you may need it someday.)
   - **Region:** the one closest to you.
3. Click **Create new project** and wait a minute or two while it gets ready.

## 2. Create the table
1. In the left menu, open **SQL Editor**, then click **New query** (or the **+**).
2. Open `supabase-setup.sql` from this project, copy **all** of it, and paste it in.
3. Click **Run**. It should say "Success. No rows returned".

## 3. Create your login
1. Left menu: **Authentication** → **Users** → **Add user** → **Create new user**.
2. Type your email and a password for the tracker, tick **Auto Confirm User**, then **Create user**.
3. So strangers can't make accounts on your project: go to **Authentication** → **Sign In / Providers**
   and turn **off** "Allow new users to sign up". Click **Save**.

## 4. Copy the two connection values
Click the **Connect** button at the top (or **Project Settings → API Keys / Data API**) and copy:
- the **Project URL**, like `https://abcdefgh.supabase.co`
- the **anon public** key (a long text starting with `eyJ…`) or the **publishable** key (`sb_publishable_…`)

These two are made to be public, so they can go in the code. **Never** copy the
`service_role` or `secret` key; that one must stay private.

## 5. Sign in on each device
Open the tracker → **Profile** → type your email and password → **Sign in**.
The top-right corner should say **Synced ✓**. Do this once per device (phone, computer).

## What the status in the top-right means
- **Synced ✓**: everything is saved online.
- **2 waiting…**: saved on this device, about to be sent.
- **Offline · 2 waiting**: no internet; sent automatically when you're back online.
- **⚠ …**: something went wrong, for example you need to sign in again in Profile.
- **Not signed in**: logs stay on this device only until you sign in.

## If the project gets paused
Free Supabase projects pause after about a week without use. If the tracker shows an error,
open <https://supabase.com/dashboard>, pick the project and click **Restore**.
