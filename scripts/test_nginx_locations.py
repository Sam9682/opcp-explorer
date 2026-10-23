#!/usr/bin/env python3
"""Test script for nginx dynamic location management"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.nginx_manager import (
    insert_location_block,
    remove_location_block,
    generate_location_block,
    read_nginx_config,
    test_nginx_config
)

def test_generate_location():
    """Test location block generation (fallback: derive HTTP port from URL)."""
    print("Testing location block generation...")
    block = generate_location_block(2, "ai-staticwebsite", "https://www.swautomorph.com:6217", "https://www.swautomorph.com:6217")

    assert "/2/ai-staticwebsite" in block
    # With no live container ports discovered, nginx falls back to deriving the
    # HTTP endpoint from the stored HTTPS URL (HTTP port = HTTPS port - 1).
    assert "http://www.swautomorph.com:6216" in block
    assert "https://www.swautomorph.com:6217" not in block
    assert "proxy_pass" in block
    assert "proxy_redirect" in block
    # Path must be PRESERVED: proxy_pass has no URI part (no trailing slash),
    # so the /2/ai-staticwebsite/ prefix is forwarded to the upstream.
    assert "proxy_pass http://www.swautomorph.com:6216;" in block
    assert "proxy_pass http://www.swautomorph.com:6216/;" not in block

    print("✓ Location block generation works")
    print(block)


def test_generate_location_https_sidecar():
    """When a real HTTPS sidecar port is discovered, proxy through it over HTTPS."""
    print("\nTesting HTTPS sidecar upstream selection...")
    # Simulate the ai-shai-web-interface case: sidecar HTTPS on 6124, raw
    # backend HTTP on 6129. The platform must target the sidecar (6124), not
    # the raw backend (6129).
    block = generate_location_block(
        "admin", "ai-shai-web-interface",
        "https://agentic-ai-plateform.com:6124",
        "https://agentic-ai-plateform.com:6124",
        real_http_port=6129, real_https_port=6124,
    )

    assert "proxy_pass https://agentic-ai-plateform.com:6124;" in block, block
    # Must NOT bypass the sidecar to hit the raw backend port.
    assert "6129" not in block, block
    # Path preserved: no trailing slash URI part on proxy_pass.
    assert "proxy_pass https://agentic-ai-plateform.com:6124/;" not in block, block
    # Self-signed sidecar cert handling present.
    assert "proxy_ssl_verify off;" in block, block
    print("✓ HTTPS sidecar upstream + path preservation works")


def test_generate_location_http_backend_only():
    """When only a real HTTP backend port is discovered, proxy over HTTP to it."""
    print("\nTesting HTTP-only backend upstream selection...")
    block = generate_location_block(
        2, "ai-staticwebsite",
        "https://www.swautomorph.com:6217",
        "https://www.swautomorph.com:6217",
        real_http_port=6300, real_https_port=None,
    )
    assert "proxy_pass http://www.swautomorph.com:6300;" in block, block
    assert "proxy_pass http://www.swautomorph.com:6300/;" not in block, block
    print("✓ HTTP backend upstream + path preservation works")

def test_insert_location():
    """Test inserting location block"""
    print("\nTesting location block insertion...")

    # Test with sample data
    result = insert_location_block(2, "ai-staticwebsite", "https://www.swautomorph.com:6217",  "https://www.swautomorph.com:6217")

    if result:
        print("✓ Location block inserted successfully")

        # Verify it's in the config
        config = read_nginx_config()
        if "/2/ai-staticwebsite" in config:
            print("✓ Location block found in config")
        else:
            print("✗ Location block not found in config")
    else:
        print("✗ Failed to insert location block")

def test_remove_location():
    """Test removing location block"""
    print("\nTesting location block removal...")

    result = remove_location_block(2, "ai-staticwebsite")

    if result:
        print("✓ Location block removed successfully")

        # Verify it's removed from config
        config = read_nginx_config()
        if "/2/ai-staticwebsite" not in config:
            print("✓ Location block removed from config")
        else:
            print("✗ Location block still in config")
    else:
        print("✗ Failed to remove location block")

def main():
    print("=== Nginx Dynamic Location Tests ===\n")

    try:
        test_generate_location()
        test_generate_location_https_sidecar()
        test_generate_location_http_backend_only()
        test_insert_location()
        test_remove_location()

        print("\n=== All tests completed ===")
        return 0

    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(main())