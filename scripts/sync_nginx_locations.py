#!/usr/bin/env python3
"""CLI tool to sync nginx locations from database"""
import sys
import os

# Add parent directory to path
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)

# Load DB credentials from the project's .env before importing the DB layer
from dotenv import load_dotenv
load_dotenv(os.path.join(ROOT_DIR, '.env'))

from src.database_postgres import db_manager
from src.nginx_manager import sync_all_locations

def main():
    print("Synchronizing nginx locations from database...")

    try:
        if sync_all_locations(db_manager):
            print("✓ Nginx locations synced successfully")
            return 0
        else:
            print("✗ Failed to sync nginx locations")
            return 1
    except Exception as e:
        print(f"✗ Error: {e}")
        return 1

if __name__ == '__main__':
    sys.exit(main())