# Connecting the tracker to Google Sheets

You only do this once. It takes about 5 minutes.

## 1. Make the sheet
1. Go to <https://sheets.new> (makes a new, empty Google Sheet).
2. Click the title "Untitled spreadsheet" and name it **Workout Tracker**.

## 2. Add the script
1. In the sheet's menu: **Extensions → Apps Script**. A code editor opens in a new tab.
2. Delete the little bit of code that's already there.
3. Open `google-apps-script.gs` from this project, copy **all** of it, and paste it in.
4. Near the top, change `"CHANGE-ME"` to a password of your own, e.g. `"blue-kettle-42"`.
   - Use a new password, **not** your Google password.
   - Change it only here in Google's editor, never in the project file (that one will be public).
5. Click the 💾 **Save** icon.

## 3. Publish it as a web app
1. Click the blue **Deploy** button → **New deployment**.
2. Next to "Select type", click the ⚙️ gear → **Web app**.
3. Fill in:
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
     (anyone with the address can *reach* the script, but it does nothing without your password)
4. Click **Deploy**.
5. Google asks for permission:
   - Click **Authorize access** and pick your Google account.
   - You'll see "Google hasn't verified this app". That's normal for a script you wrote yourself:
     click **Advanced** → **Go to Workout Tracker (unsafe)** → **Allow**.
6. Copy the **Web app URL** (it ends in `/exec`).

**Check it works:** paste that URL into a new browser tab. You should see
`"Workout tracker script is running."`

## 4. Connect the website
1. Open the tracker, go to **Profile**.
2. Paste the URL into **Script address**, type your password, tap **Save and sync**.
3. The top-right corner should say **Synced ✓**, and new tabs (Workouts, Weights, …) appear in your sheet.

Do step 4 once on every device (phone, computer).

## If you change the script later
Use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
This keeps the same URL, so you don't need to reconnect your devices.

## What the status in the top-right means
- **Synced ✓**: everything is in the sheet.
- **2 waiting…**: saved on this device, about to be sent.
- **Offline · 2 waiting**: no internet; it sends them automatically when you're back online.
- **⚠ Wrong password** / **⚠ Check the script address**: fix it in Profile.
- **This device only**: not connected to a sheet yet.
