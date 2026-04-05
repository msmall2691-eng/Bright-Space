"""
One-time Google Calendar authorization script.
Run this once from the backend folder:
    python auth_google.py

It will open your browser, ask you to log in with office@mainecleaningco.com,
and save google_token.json. After that, BrightBase can create calendar events automatically.
"""

import os
from pathlib import Path
from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/calendar"]
BASE = Path(__file__).parent
CREDS_FILE = BASE / os.getenv("GOOGLE_CREDENTIALS_FILE", "google_credentials.json")
TOKEN_FILE  = BASE / os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")

if not CREDS_FILE.exists():
    print(f"ERROR: {CREDS_FILE} not found.")
    print("Download it from Google Cloud Console → APIs & Services → Credentials")
    exit(1)

print("Opening browser for Google authorization...")
print("Log in with: office@mainecleaningco.com\n")

flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
creds = flow.run_local_server(port=0)

with open(TOKEN_FILE, "w") as f:
    f.write(creds.to_json())

print(f"\n✅ Authorization complete! Token saved to: {TOKEN_FILE}")
print("BrightBase can now create Google Calendar events automatically.")
