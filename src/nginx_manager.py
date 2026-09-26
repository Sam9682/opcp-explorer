"""Nginx configuration manager for dynamic location blocks"""
import os
import subprocess
import logging
from typing import Optional
from urllib.parse import urlparse, urlunparse
from .config_postgres import PLTF_FOLDER

logger = logging.getLogger(__name__)

NGINX_CONF_DIR = "/etc/nginx/sites-available"
NGINX_ENABLED_DIR = "/etc/nginx/sites-enabled"
NGINX_CONF_FILE = PLTF_FOLDER


def to_http_upstream_url(user_appli_url: str) -> str:
    """Convert an application URL to the HTTP upstream used by nginx proxy_pass.

    Application URLs are stored using the HTTPS scheme and the HTTPS port
    (the second entry of each port pair, e.g. ``https://host:8525``). The
    upstream that nginx should proxy to is the HTTP endpoint: the HTTP
    scheme and the HTTP port, which is the first entry of the pair and always
    one below the HTTPS port (e.g. ``http://host:8524``).

    The URL is returned without a trailing slash; callers append their own.
    """
    if not user_appli_url:
        return user_appli_url

    raw = user_appli_url.rstrip('/')

    try:
        # urlparse only fills netloc/port when the URL has a "//" authority.
        # For bare "host:port" forms it mistakes the host for the scheme, so
        # normalise by prepending a scheme when one is absent.
        if "://" not in raw:
            raw_for_parse = f"https://{raw}"
        else:
            raw_for_parse = raw
        parsed = urlparse(raw_for_parse)

        host = parsed.hostname
        port = parsed.port

        if host is None:
            # Could not parse a host; fall back to the original value.
            return raw

        if port is not None:
            # HTTP port is the first of the HTTP/HTTPS pair (one below HTTPS).
            http_port = port - 1 if port > 0 else port
            netloc = f"{host}:{http_port}"
        else:
            netloc = host

        rebuilt = urlunparse(('http', netloc, parsed.path or '', parsed.params, parsed.query, parsed.fragment))
        return rebuilt.rstrip('/')
    except (ValueError, IndexError):
        logger.warning("Could not derive HTTP upstream from URL '%s'; using it as-is", user_appli_url)
        return raw


def generate_location_block(user_name: str, app_name: str, deployment_url: str, user_appli_url: str) -> str:
    """Generate nginx location block for user application"""
    location_path = f"/{user_name}/{app_name}/"

    # nginx must proxy to the HTTP endpoint (HTTP scheme + HTTP port, the first
    # port of the pair), not the HTTPS one stored on the application URL.
    user_appli_url = to_http_upstream_url(user_appli_url)

    return f"""
    # Dynamic location for user {user_name} - {app_name}
    location {location_path} {{
        proxy_pass {user_appli_url}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Redirect rewriting to preserve context path
        proxy_redirect {user_appli_url}/ {location_path};
        proxy_redirect / {location_path};

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Timeouts
        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Rewrite HTML content to fix absolute paths
        sub_filter 'href="/' 'href="{location_path}';
        sub_filter 'src="/' 'src="{location_path}';
        sub_filter_once off;
        sub_filter_types text/css text/javascript application/javascript;
    }}
"""

def get_nginx_config_path() -> str:
    """Get the path to the nginx configuration file"""
    return os.path.join(NGINX_CONF_DIR, NGINX_CONF_FILE)

def read_nginx_config() -> str:
    """Read current nginx configuration"""
    config_path = get_nginx_config_path()
    
    try:
        with open(config_path, 'r') as f:
            return f.read()
    except Exception as e:
        logger.error(f"Failed to read nginx config: {e}")
        raise

def write_nginx_config(config: str) -> bool:
    """Write nginx configuration to file"""
    config_path = get_nginx_config_path()
    
    try:
        # Write to temp file first
        temp_path = f"/tmp/{NGINX_CONF_FILE}"
        with open(temp_path, 'w') as f:
            f.write(config)
        
        # Move with sudo
        result = subprocess.run(['sudo', 'mv', temp_path, config_path], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            logger.error(f"Failed to move config: {result.stderr}")
            return False
        
        # Set proper permissions
        subprocess.run(['sudo', 'chmod', '644', config_path], capture_output=True, text=True, timeout=10)
        
        # Create symlink in sites-enabled if not exists
        enabled_path = os.path.join(NGINX_ENABLED_DIR, NGINX_CONF_FILE)
        if not os.path.exists(enabled_path):
            subprocess.run(['sudo', 'ln', '-sf', config_path, enabled_path], capture_output=True, text=True, timeout=10)
        
        return True
    except Exception as e:
        logger.error(f"Failed to write nginx config: {e}")
        return False

def insert_location_block(user_name: str, app_name: str, deployment_url: str, user_appli_url: str) -> bool:
    """Insert or update location block in nginx configuration"""
    try:
        config = read_nginx_config()
        location_block = generate_location_block(user_name, app_name, deployment_url, user_appli_url)
        
        # Remove existing location block for this user/app if exists
        marker_start = f"# Dynamic location for user {user_name} - {app_name}"
        marker_end = "}"
        
        lines = config.split('\n')
        new_lines = []
        skip = False
        
        for line in lines:
            if marker_start in line:
                skip = True
            if not skip:
                new_lines.append(line)
            if skip and marker_end in line and line.strip() == marker_end:
                skip = False
        
        config = '\n'.join(new_lines)
        
        # Insert before the main location / block in the 443 server
        location_root_idx = config.find('    location / {')
        if location_root_idx != -1:
            config = config[:location_root_idx] + location_block + '\n' + config[location_root_idx:]
        
        # Write configuration
        if write_nginx_config(config):
            return reload_nginx()
        
        return False
        
    except Exception as e:
        logger.error(f"Failed to insert location block: {e}")
        return False

def remove_location_block(user_name: str, app_name: str) -> bool:
    """Remove location block from nginx configuration"""
    try:
        config = read_nginx_config()
        
        # Remove location block
        marker_start = f"# Dynamic location for user {user_name} - {app_name}"
        marker_end = "}"
        
        lines = config.split('\n')
        new_lines = []
        skip = False
        
        for line in lines:
            if marker_start in line:
                skip = True
            if not skip:
                new_lines.append(line)
            if skip and marker_end in line and line.strip() == marker_end:
                skip = False
        
        config = '\n'.join(new_lines)
        
        # Write configuration
        if write_nginx_config(config):
            return reload_nginx()
        
        return False
        
    except Exception as e:
        logger.error(f"Failed to remove location block: {e}")
        return False

def test_nginx_config() -> bool:
    """Test nginx configuration for syntax errors"""
    try:
        result = subprocess.run(['sudo', 'nginx', '-t'], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            logger.error(f"Nginx config test failed: {result.stderr}")
        return result.returncode == 0
    except Exception as e:
        logger.error(f"Failed to test nginx config: {e}")
        return False

def reload_nginx() -> bool:
    """Reload nginx configuration"""
    try:
        result = subprocess.run(['sudo', 'nginx', '-t'], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            logger.error(f"Nginx configuration test failed: {result.stderr}")
            return False
        
        result = subprocess.run(['sudo', 'systemctl', 'reload', 'nginx'], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            logger.info("Nginx reloaded successfully")
            return True
        else:
            logger.error(f"Failed to reload nginx: {result.stderr}")
            return False
    except Exception as e:
        logger.error(f"Failed to reload nginx: {e}")
        return False

def sync_all_locations(db_manager) -> bool:
    """Sync all user application locations from database"""
    try:
        # Get all user applications with URLs
        apps = db_manager.execute_query("""
            SELECT u.username, a.name, ua.url
            FROM user_applications ua
            JOIN applications a ON ua.application_id = a.id
            JOIN users u ON ua.user_id = u.id
            WHERE ua.url IS NOT NULL AND ua.url != ''
        """, fetch_all=True)
        
        if not apps:
            logger.info("No applications to sync")
            return True
        
        # Start with base configuration
        config = read_nginx_config()
        
        # Clear all dynamic locations
        lines = config.split('\n')
        new_lines = []
        skip = False
        
        for line in lines:
            if '# Dynamic location for user' in line:
                skip = True
            if not skip:
                new_lines.append(line)
            if skip and line.strip() == '}':
                skip = False
        
        config = '\n'.join(new_lines)
        
        # Insert all location blocks before the main location / block
        location_blocks = []
        for app in apps:
            user_name, app_name, url = app
            location_blocks.append(generate_location_block(user_name, app_name, url, url))
        
        # Insert before location / in the 443 server
        location_root_idx = config.find('    location / {')
        if location_root_idx != -1:
            config = config[:location_root_idx] + '\n'.join(location_blocks) + '\n' + config[location_root_idx:]
        
        # Write and reload
        if write_nginx_config(config):
            return reload_nginx()
        
        return False
        
    except Exception as e:
        logger.error(f"Failed to sync locations: {e}")
        return False
