"""
One-time import of clients from Job export (1).xlsx into BrightBase.
Run from C:\BrightBase\backend with: venv\Scripts\python import_clients.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from database.db import init_db, SessionLocal
from database.models import Client

# Parsed client data from Job export (1).xlsx
# Skip: Storage Unit, Miscellaneous, Sandra (duplicate/utility rows)
# Commercial clients flagged in notes; names cleaned where needed
CLIENTS = [
    {
        "name": "Andrew Nadeau",
        "address": "6 White Pine Lane",
        "city": "Kennebunk",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Anna Sweet",
        "address": "4 Red Barn Circle",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Ashley Besemer",
        "address": "21 Crestwood Dr",
        "city": "Standish",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Ashley Williams",
        "address": "37 Joshua Lane",
        "city": "Hollis",
        "state": "ME",
        "zip_code": "04042",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Bre Lynch",
        "address": "12 Freedom Rd",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Brian Allen",
        "address": "130 Plummer Rd",
        "city": "Gorham",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Captain Jack's",
        "address": "34 Naples Marina Lane",
        "city": "Naples",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
        "notes": "Commercial client",
    },
    {
        "name": "Casey Allison",
        "address": "17 Oakmont Drive",
        "city": "Falmouth",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Christine Chasse",
        "address": "6 Greta Way",
        "city": "Falmouth",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Deanna McLean",
        "address": "13 Wild Flower Lane",
        "city": "Windham",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Jess Racco",
        "address": "729 Ocean Ave",
        "city": "Wells",
        "state": "ME",
        "zip_code": "04090",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Joanna Fox",
        "address": "116 E Shore Beach Road",
        "city": "Naples",
        "state": "ME",
        "zip_code": "04055",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "John Mangini",
        "address": "74 Central Park Avenue",
        "city": "Old Orchard Beach",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Kelly Whetstone",
        "address": "4 Landmark Rd",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "04074",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Kerry Martin",
        "address": "5 Moors Point Road",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Lindsey Gauthier",
        "address": "12 Farmhouse Rd",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Lindsay Woods",
        "address": "1 Harvest Ln",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "04074",
        "status": "active",
        "source": "connecteam_import",
        "notes": "Bi-monthly schedule",
    },
    {
        "name": "Lisa Shaker",
        "address": "8 Noel Dr",
        "city": "Windham",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Living Innovations",
        "address": "21 Anglers Road",
        "city": "Windham",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
        "notes": "Commercial client",
    },
    {
        "name": "Meredith Curtis",
        "address": "54 Mitchell Hill Rd",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Natalya D.",
        "address": "22 Kincaid St",
        "city": "South Portland",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Nora Lantagne",
        "address": "267 Douglas Hill Road",
        "city": "West Baldwin",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Paul Day",
        "address": "360 Capisic St",
        "city": "Portland",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Ranae Mogensen",
        "address": "36 Park Street",
        "city": "Kennebunk",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Sandra Fox",
        "address": "18 Kerryman Circle",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
    },
    {
        "name": "Sharon Hogan",
        "address": "36 Fire Ln 25",
        "city": "Naples",
        "state": "ME",
        "zip_code": "04055",
        "status": "active",
        "source": "connecteam_import",
        "notes": "Bi-weekly schedule",
    },
    {
        "name": "Spin Drift Maine",
        "address": "22 Kincaid Street #2",
        "city": "South Portland",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
        "notes": "STR property — link to Spin Drift property for iCal sync",
    },
    {
        "name": "Throttle Car Club",
        "address": "10 Dynamic Drive",
        "city": "Scarborough",
        "state": "ME",
        "zip_code": "",
        "status": "active",
        "source": "connecteam_import",
        "notes": "Commercial client",
    },
]


def main():
    init_db()
    db = SessionLocal()
    try:
        existing = {c.name.lower() for c in db.query(Client).all()}
        added = 0
        skipped = 0
        for data in CLIENTS:
            if data["name"].lower() in existing:
                print(f"  SKIP (exists): {data['name']}")
                skipped += 1
                continue
            client = Client(**data)
            db.add(client)
            added += 1
            print(f"  ADD: {data['name']} — {data.get('city', '')}, {data.get('state', '')}")
        db.commit()
        print(f"\nDone. Added {added}, skipped {skipped} (already exist).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
