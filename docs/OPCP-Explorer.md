# OPCP-Explorer AI-Powered Store

## Objective

OPCP-Explorer is a centralized application deployment and management platform designed for GenAI agents. It provides automated deployment, lifecycle management, and SSO authentication for web applications through multiple interfaces (Web, CLI, API, MCP).

**Core Purpose**: Enable GenAI agents to autonomously deploy, manage, and access web applications without human intervention.

**Platform Name**: OPCP-Explorer_AI_SharedGPU_Docker_Serverless
**Domain**: opcp-psmc.com
**Version**: 0.0.1

## Features

- 🔐 User registration and authentication with Gitea integration
- 🌐 Web-based dashboard with multi-language support (EN/FR)
- 📱 Application management with **PostgreSQL database** (enterprise-grade performance)
- 🔑 SSO Identity Provider with token-based authentication
- 🚀 **Application deployment system** (Clone, Start, Stop, Monitor, Logs)
- 🐳 Docker containerization with docker-compose
- 🖥️ Command-line interface (CLI) with comprehensive commands
- 🔌 REST API endpoints with streaming support (Server-Sent Events)
- 🤖 MCP (Model Context Protocol) support
- 🛡️ ModSecurity WAF protection with OWASP CRS rules
- 🔄 Automated database backups with PostgreSQL pg_dump and history tracking
- 💰 Billing and cost tracking system with activity logging and PDF invoices
- 🤖 **Virtual AI Agents**: AI Chat Developer and Operations assistants (kiro-cli, qchat, shai engines)
- 📊 Database health monitoring and statistics
- 🌐 Multi-server deployment support with capacity management
- 🔀 **Dynamic Nginx Locations**: Automatic reverse proxy configuration per user/app
- 📖 Comprehensive user guide and documentation
- 🔧 **PostgreSQL connection pooling** with thread-safe operations
- 🔄 **SQLite to PostgreSQL migration tools**
- 🎮 **MIG Shared GPU**: NVIDIA Multi-Instance GPU partitioning and management per server
- ⚡ **Serverless Docker Execution**: Submit and run Docker-based jobs on-demand with remote brik endpoint dispatching
- 🔄 **Multi-server Replication**: Peer-to-peer database replication with sync tokens and version-based conflict resolution
- 🎭 **App Orchestrator**: Automated application lifecycle orchestration with reconciliation loop and multi-user deployment
- 🔒 **Password Reset & 2FA**: Secure password recovery and two-factor authentication (TOTP + email-based)
- 📧 **Email Service**: SMTP-based notifications for password reset and 2FA verification codes
- 🔍 **Platform Discovery**: Automatic multi-server role detection (PRIMARY/SECONDARY)
- 🏗️ **Infrastructure as Code**: Terraform templates for OVHcloud provisioning
- 📦 **Deployment Backups History**: JSONB-tracked backup history per deployment with S3 sync

## PostgreSQL Migration

### Database Migration
```bash
# Run the automated migration from SQLite to PostgreSQL
python3 ./migration/migrate_sqlite_to_postgres.py

# Configure PostgreSQL connection (environment variables)
export POSTGRES_HOST="localhost"
export POSTGRES_PORT="5432"
export POSTGRES_DB="ai_swautomorph"
export POSTGRES_USER="swautomorph"
export POSTGRES_PASSWORD="swautomorph_password"
```

### Migration Features
- ✅ **Complete Data Migration**: Preserves all existing data during transition
- 🔄 **Type Conversion**: Automatic SQLite to PostgreSQL data type mapping
- 📊 **Schema Mapping**: Column name normalization (SERVER_IP → server_ip)
- ⚡ **Sequence Reset**: Automatic adjustment of auto-increment sequences
- 🔒 **Transaction Safety**: Full rollback capability on migration errors

## Installation Methods

### Prerequisites Check
```bash
# Verify system requirements
which python3 && which pip && which docker && which docker-compose
```

### Interactive Deployment (Recommended)
```bash
# Clone repository
git clone https://github.com/your-repo/opcp-explorer.git
cd <PLTF_FOLDER>

# Interactive deployment with menu selection
./deployControlPlan.sh start
```

### Local System Deployment
```bash
# Deploy directly on host system (production)
./deployControlPlan.sh start locally

# With custom user parameters
./deployControlPlan.sh start locally 123 "John Doe" "john@example.com" "Production Deployment"
```

### Docker Deployment
```bash
# Deploy using Docker containers (development/testing)
./deployControlPlan.sh start docker

# Or direct docker-compose
docker-compose up -d --build
```

### Manual Installation Steps
```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Initialize database
python3 ./scripts/aipoweredstore_cli.py init-db

# 3. Start application
python3 src/ControlPlanFlaskApp_postgres.py
```

### Bare-Metal Installation (Ubuntu/Debian)

For a fresh bare-metal server running Ubuntu 22.04+ or Debian 12+, the `init_pltf.sh` script automates the complete platform provisioning. This is the recommended method for production deployments on OVHcloud dedicated servers or VPS.

#### Prerequisites

| Requirement | Details |
|-------------|---------|
| OS | Ubuntu 22.04+ or Debian 12+ |
| User | Non-root user with `sudo` privileges |
| Network | Internet access (public interface) |
| SSH key | Configured for GitHub repository access |
| GPU (optional) | NVIDIA H100, A100, or A30 for MIG shared GPU |

#### Run the provisioning script

```bash
chmod +x init_pltf.sh
./init_pltf.sh
```

#### What the script installs (in order)

| Step | Component | Purpose |
|------|-----------|---------|
| 1 | Python 3, pip, venv, net-tools, unzip | Application runtime and system utilities |
| 2 | Amazon Kiro CLI | AI-assisted development CLI |
| 3 | OVH shai CLI | OVHcloud infrastructure management |
| 4 | AWS CLI v2 | S3-compatible object storage access |
| 5 | Terraform 1.14.5 | Infrastructure as Code |
| 6 | Network configuration | Netplan route metrics (public: 50, private: 200) |
| 7 | Docker + docker-compose | Container orchestration engine |
| 8 | NVIDIA Driver 550 + MIG mode | GPU compute and Multi-Instance GPU partitioning |
| 9 | NVIDIA Container Toolkit | Docker GPU passthrough (`--gpus` flag) |
| 10 | AWS credentials | S3 endpoint configuration for OVHcloud |
| 11 | Repository clone | Source code + submodules |
| 12 | Python virtualenv | Dependencies from requirements.txt |
| 13 | Final setup | logs/ directory, ModSecurity config, deployments/ |

#### GPU setup detail

The script automatically handles GPU provisioning with graceful fallback:

```
NVIDIA driver install
    ├── Success → Enable MIG mode (nvidia-smi -mig 1)
    │                ├── Success → Install nvidia-container-toolkit
    │                │                 └── Verify Docker GPU access (30s timeout)
    │                └── Warning → GPU may not support MIG, continue
    └── Warning → No GPU detected, skip GPU setup entirely
```

All GPU steps are **non-blocking** — the platform works without GPU hardware.

#### Post-installation (manual steps)

After `init_pltf.sh` completes, configure these items:

```bash
# 1. Platform identity
vim ~/<PLTF_FOLDER>/conf/deploy.ini
# Set: DOMAIN=yourdomain.com
# Set: PLTF_NAME=Your Platform Name

# 2. SSL certificates
cp fullchain.crt ~/<PLTF_FOLDER>/ssl/fullchain_domain.crt
cp private.key ~/<PLTF_FOLDER>/ssl/privateKey_domain.key

# 3. S3 credentials for backups
vim ~/.aws/credentials
# Replace XXX/YYY with your OVHcloud S3 access/secret keys

# 4. Apply Docker group (required for docker commands without sudo)
newgrp docker
# Or log out and back in

# 5. Start the platform
cd ~/<PLTF_FOLDER>
source .venv/bin/activate
./deployControlPlan.sh start
```

## Configuration

### Environment Variables
```bash
# Automatically generated during deployment
SECRET_KEY="auto-generated-32-byte-hex"
FLASK_ENV="production"

# SMTP Configuration for email service (password reset, 2FA)
SMTP_HOST="localhost"
SMTP_PORT=587
SMTP_USER=""
SMTP_PASSWORD=""
SMTP_FROM_EMAIL="noreply@softfluid.fr"
SMTP_FROM_NAME="AI-SwAutoMorph"
SMTP_USE_TLS="true"

# Replication sync secret
SYNC_SECRET="your-sync-secret"
```

### Configuration File
```bash
# Edit deployment configuration
vim ./conf/deploy.ini

# Key settings:
DOMAIN="opcp-psmc.com"
PLTF_NAME="OPCP-Explorer_AI_SharedGPU_Docker_Serverless"
PLTF_FOLDER="opcp-explorer"
VERSION="0.0.1"
```

### Serverless Configuration
```ini
# conf/serverless.ini
[registry]
whitelist = docker.io, ghcr.io, registry.example.com

[resources]
default_memory_limit = 512m
default_cpu_limit = 1
max_concurrent_jobs = 100

[timeouts]
default_timeout = 300
max_timeout = 3600
container_stop_timeout = 10
poll_interval = 0.5

[logging]
log_retention_days = 30
```

### Database Initialization
```bash
# Initialize database schema
python3 ./scripts/aipoweredstore_cli.py init-db

# Check database health
python3 ./scripts/aipoweredstore_cli.py db-health
```

### SSL Certificate Setup
```bash
# Auto-generate self-signed certificate
./scripts/generate_ssl.sh

# Let's Encrypt setup
./scripts/setup_letsencrypt.sh

# Or use production certificates (place in ssl/ directory)
# - fullchain_domain.crt
# - privateKey_domain.key
```

## API Access for GenAI Agents

### User Registration
```bash
curl -X POST https://opcp-psmc.com/register \
  -H "Content-Type: application/json" \
  -d '{"username":"agent","email":"agent@example.com","password":"secure_pass","first_name":"AI","last_name":"Agent"}'
```

### Application Management
```bash
# List applications
curl https://opcp-psmc.com/api/applications

# Add application (admin required)
curl -X POST https://opcp-psmc.com/api/applications \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"name":"MyApp","description":"My Application","git_url":"https://github.com/user/myapp.git"}'

# Deploy application with streaming
curl -X POST https://opcp-psmc.com/api/deployments \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"application_name":"MyApp","action":"clone","git_url":"https://github.com/user/myapp.git","server_id":1,"stream":true}'

# Application lifecycle management
curl -X POST https://opcp-psmc.com/api/deployments \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"application_name":"MyApp","action":"start"}'
```

### Enhanced Server Management
```bash
# List servers with capacity information
curl https://opcp-psmc.com/api/servers

# Allocate server for deployment (automatic capacity-based selection)
curl -X POST https://opcp-psmc.com/api/server/allocate \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"application_name":"MyApp"}'

# Add new server (admin required)
curl -X POST https://opcp-psmc.com/api/servers \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"SERVER_IP":"192.168.1.100","SERVER_NAME":"worker-01","SERVER_CAPACITY_USER_MAX":20,"SERVER_CAPACITY_APPLI_MAX":100,"SERVER_STATUS":"STAND_BY","SERVER_TYPE":"worker"}'
```

### MIG Shared GPU Management
```bash
# Enable shared GPU on a server (admin required)
curl -X PUT https://opcp-psmc.com/api/servers/1/gpu/enabled \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"enabled": true}'

# List available MIG profiles from GPU hardware
curl https://opcp-psmc.com/api/servers/1/gpu/profiles \
  -H "Cookie: session=your-session-cookie"

# Create MIG instances (1-7 profile IDs)
curl -X POST https://opcp-psmc.com/api/servers/1/gpu/instances \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"profile_ids": ["9", "14", "9"]}'

# List active MIG instances
curl https://opcp-psmc.com/api/servers/1/gpu/instances \
  -H "Cookie: session=your-session-cookie"

# Destroy all MIG instances on a server
curl -X DELETE https://opcp-psmc.com/api/servers/1/gpu/instances \
  -H "Cookie: session=your-session-cookie"
```

### Serverless Docker Execution
```bash
# List available serverless endpoints with availability status
curl https://opcp-psmc.com/api/serverless-links \
  -H "Cookie: session=your-session-cookie"
# Response: {"links": ["https://opcp-psmc.com:6133"], "endpoints": [{"url": "...", "username": "admin", "status": "AVAILABLE"}]}

# Submit a serverless Docker job (target_link required)
curl -X POST https://opcp-psmc.com/api/jobs \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"image": "python:3.11", "command": ["python", "-c", "print(\"hello\")"], "timeout": 60, "target_link": "https://opcp-psmc.com:6133"}'

# Check job status (auto-syncs with remote brik endpoint)
curl https://opcp-psmc.com/api/jobs/<job_id> \
  -H "Cookie: session=your-session-cookie"

# Get job result (stdout, stderr, exit_code)
curl https://opcp-psmc.com/api/jobs/<job_id>/result \
  -H "Cookie: session=your-session-cookie"

# Cancel a pending or running job
curl -X POST https://opcp-psmc.com/api/jobs/<job_id>/cancel \
  -H "Cookie: session=your-session-cookie"

# List user jobs (with pagination and status filter)
curl "https://opcp-psmc.com/api/jobs?page=1&per_page=20&status=completed" \
  -H "Cookie: session=your-session-cookie"

# Get job metrics (admin only)
curl https://opcp-psmc.com/api/jobs/metrics \
  -H "Cookie: session=your-session-cookie"
```

### App Orchestrator
```bash
# List services and their instances
curl https://opcp-psmc.com/api/orchestrator/services \
  -H "Cookie: session=your-session-cookie"

# Create a new service (admin)
curl -X POST https://opcp-psmc.com/api/orchestrator/services \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"name":"MyService","image":"https://github.com/user/repo.git","desired_replicas":2}'

# Multi-user deployment (creates N replica users with app instances)
curl -X POST https://opcp-psmc.com/api/orchestrator/services/multi-user-deploy \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"name":"MyApp","image":"https://github.com/user/repo.git","desired_replicas":3}'

# Scale a service
curl -X POST https://opcp-psmc.com/api/orchestrator/services/MyService/scale \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"replicas": 3}'

# Trigger health check
curl -X POST https://opcp-psmc.com/api/orchestrator/health-check \
  -H "Cookie: session=your-session-cookie"

# Get orchestrator status and statistics
curl https://opcp-psmc.com/api/orchestrator/status \
  -H "Cookie: session=your-session-cookie"

# Trigger manual reconciliation
curl -X POST https://opcp-psmc.com/api/orchestrator/reconcile \
  -H "Cookie: session=your-session-cookie"
```

### Multi-server Replication
```bash
# Check replication health
curl https://opcp-psmc.com/api/sync/health

# Get detailed replication status (peer count, queue size)
curl https://opcp-psmc.com/api/sync/status

# Replicate event to peer (internal, uses X-Sync-Token header)
curl -X POST https://opcp-psmc.com/api/sync/replicate \
  -H "X-Sync-Token: your-sync-secret" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"uuid","timestamp":"...","table":"USERS","operation":"INSERT","data":{}}'
```

### Password Reset & Two-Factor Authentication
```bash
# Request password reset (authenticated user)
curl -X POST https://opcp-psmc.com/security/password-reset/request \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"user_id": 2}'

# Change password (logged-in user)
curl -X POST https://opcp-psmc.com/security/change-password \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"current_password":"old_pass","new_password":"new_pass"}'

# Setup TOTP 2FA
curl -X POST https://opcp-psmc.com/security/2fa/setup \
  -H "Cookie: session=your-session-cookie"

# Enable email-based 2FA
curl -X POST https://opcp-psmc.com/security/2fa/enable-email \
  -H "Cookie: session=your-session-cookie"

# Get 2FA status
curl https://opcp-psmc.com/security/2fa/status \
  -H "Cookie: session=your-session-cookie"

# Verify 2FA during login
curl -X POST https://opcp-psmc.com/security/2fa/verify-login \
  -H "Content-Type: application/json" \
  -d '{"code":"123456","method":"totp"}'
```

### Dynamic Nginx Locations
```bash
# Access user applications via dynamic URLs
# Format: https://opcp-psmc.com/{USER_ID}/{APPLICATION_NAME}
# Example: User 2's ai-staticwebsite running on port 6217
curl https://opcp-psmc.com/2/ai-staticwebsite

# Sync all nginx locations from database (admin required)
curl -X POST https://opcp-psmc.com/api/nginx/sync \
  -H "Cookie: session=your-session-cookie"

# Or via CLI
python3 ./scripts/sync_nginx_locations.py
```

### Virtual AI Agents Integration
```bash
# AI Chat Developer Agent (code modifications)
curl -X POST https://opcp-psmc.com/api/request_dev_ai_for_app \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"message":"Add a new API endpoint for user management","application_name":"MyApp","application_folder":"/path/to/app","action_operation":"MODIFY_CODE"}'

# AI Chat Operations Agent (deployment operations)
curl -X POST https://opcp-psmc.com/api/request_ops_ai_for_app \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"message":"[START] Start the application","application_name":"MyApp","application_folder":"/path/to/app","action_operation":"START"}'

# Streaming deployment with real-time logs
curl -X POST https://opcp-psmc.com/api/deployments \
  -H "Content-Type: application/json" \
  -H "Cookie: session=your-session-cookie" \
  -d '{"application_name":"MyApp","action":"start","stream":true}'
```

### Enhanced CLI Interface
```bash
# Register user
python3 ./scripts/aipoweredstore_cli.py register --username agent --email agent@example.com --password secure_pass

# List applications
python3 ./scripts/aipoweredstore_cli.py list-apps

# Add application
python3 ./scripts/aipoweredstore_cli.py add-app --name MyApp --url https://myapp.com --description "My Application"

# Validate SSO token
python3 ./scripts/aipoweredstore_cli.py validate-token --token your-sso-token

# Database health check with detailed statistics
python3 ./scripts/aipoweredstore_cli.py db-health

# Mount S3 storage for backups
python3 ./scripts/aipoweredstore_cli.py mount-s3fs softfluid /mnt/s3

# Initialize database with thread-safe operations
python3 ./scripts/aipoweredstore_cli.py init-db

# Orchestrator CLI
python3 ./scripts/orchestrator_cli.py

# Install serverless worker service
./scripts/install_worker_service.sh
```

### MCP Protocol
```bash
# Start MCP server for agent communication
python3 ./scripts/mcp_server.py
```

## Service Management

### Service Status
```bash
# Check all services status
./deployControlPlan.sh ps

# View service logs
./deployControlPlan.sh logs

# Restart services
./deployControlPlan.sh restart

# Stop services
./deployControlPlan.sh stop
```

### Enhanced Health Checks
```bash
# API health check
curl https://opcp-psmc.com/api/auth/status

# Database health check with statistics (admin required)
curl https://opcp-psmc.com/api/health/database

# Platform status (multi-server role detection)
curl https://opcp-psmc.com/api/platform/status

# Check Docker services
docker-compose ps

# Check deployment logs with streaming
curl https://opcp-psmc.com/api/deployments/1/logs
```

### Serverless Worker Service
```bash
# Install the worker as a systemd service
./scripts/install_worker_service.sh

# Or run manually
python3 -m src.serverless.worker

# Environment variables for worker
export WORKER_ID="worker-001"
export POSTGRES_HOST="localhost"
export POSTGRES_PORT="5432"
export POSTGRES_DB="ai_swautomorph"
export POSTGRES_USER="swautomorph"
export POSTGRES_PASSWORD="swautomorph_password"
```

### Database Management
```bash
# Create manual backup
./deployControlPlan.sh backup_db

# Recover from backup
./deployControlPlan.sh --recover_db

# Database health check
python3 ./scripts/aipoweredstore_cli.py db-health

# Add backup to deployment history
python3 ./scripts/add_backup_to_deployment.py
```

## Default Configuration

- **Web Interface**: https://opcp-psmc.com (or https://localhost)
- **API Endpoint**: https://opcp-psmc.com/api
- **Gitea Server**: https://opcp-psmc.com/gitea (port 3000)
- **MCP Server**: Available via scripts/mcp_server.py
- **Database**: **PostgreSQL with connection pooling** (enterprise-grade performance and scalability)
- **Deployment Directory**: /home/ubuntu/deployments/[username]/[appname]
- **SSL Certificates**: ssl/ directory
- **Logs**: logs/ directory with daily rotation and Gunicorn logging
- **Backups**: softfluid/db/backup/ with S3 sync and hourly automated backups
- **Virtual Agents**: AI Chat Developer and Operations with context-aware prompts
- **Serverless Worker**: systemd service with Docker/Podman runtime auto-detection

## Architecture

### Directory Structure
```
<PLTF_FOLDER>/
├── src/                    # Main application source
│   ├── routes/            # Flask route blueprints (11 blueprints)
│   │   ├── main_routes.py        # Dashboard, docs, language, GPU page
│   │   ├── auth_routes.py        # User authentication (login, register, logout)
│   │   ├── sso_routes.py         # Single Sign-On with Gitea
│   │   ├── api_routes.py         # REST API with streaming (deployments, servers, apps)
│   │   ├── genai_routes.py       # Virtual AI agents (developer, operations)
│   │   ├── billing_routes.py     # Billing, cost tracking & PDF invoices
│   │   ├── orchestrator_routes.py # App lifecycle orchestration & multi-user deploy
│   │   ├── replication_routes.py # Multi-server replication
│   │   ├── security_routes.py   # Password reset & 2FA (TOTP + email)
│   │   ├── serverless_routes.py  # Serverless Docker execution & brik dispatching
│   │   └── gpu_routes.py         # MIG shared GPU management
│   ├── serverless/        # Serverless execution engine
│   │   ├── __init__.py
│   │   ├── worker.py            # Worker polling loop (FOR UPDATE SKIP LOCKED)
│   │   ├── container_runtime.py # Docker/Podman abstraction with security hardening
│   │   ├── config.py            # Registry whitelist, resource limits
│   │   └── log_cleanup.py       # 30-day log retention cleanup
│   ├── ControlPlanFlaskApp_postgres.py    # Main Flask application factory
│   ├── database_postgres.py      # PostgreSQL database manager with connection pooling
│   ├── config_postgres.py        # Configuration (domain, timeouts, i18n)
│   ├── nginx_manager.py          # Dynamic nginx location management
│   ├── orchestrator.py           # LightOrchestrator with reconciliation loop
│   ├── replication_manager.py    # Event-driven peer-to-peer replication
│   ├── platform_discovery.py     # Multi-server role detection (PRIMARY/SECONDARY)
│   ├── email_service.py          # SMTP email for password reset & 2FA
│   ├── auth.py                   # Authentication utilities & SSO tokens
│   └── __init__.py
├── migration/             # Database migration scripts (12 files)
│   ├── add_serverless_jobs.sql          # Serverless jobs, logs, results schema
│   ├── add_target_link_to_serverless_jobs.sql  # Remote brik endpoint targeting
│   ├── add_mig_gpu.sql                  # MIG GPU tables & server flag
│   ├── add_password_reset_and_2fa.sql   # Security features schema
│   ├── add_backups_history_to_deployments.sql  # Backup history JSONB
│   ├── add_user_id_to_services.sql      # Multi-user service isolation
│   ├── add_url_to_applications.sql      # Application URL tracking
│   ├── make_application_fkeys_deferrable.sql   # Deferrable foreign keys
│   ├── fix_server_capacity.sql          # Server capacity fix
│   ├── fix_services_constraint.sql      # Services constraint fix
│   ├── fix_deployment_user_id.sql       # Deployment user_id fix
│   └── fix_instances_fkey.sql           # Instances foreign key fix
├── scripts/               # CLI tools and utilities
│   ├── aipoweredstore_cli.py            # Platform command-line interface
│   ├── orchestrator_cli.py              # Orchestrator management CLI
│   ├── mcp_server.py                    # Model Context Protocol server
│   ├── sync_nginx_locations.py          # Nginx location sync from database
│   ├── install_worker_service.sh        # Install serverless worker systemd service
│   ├── postgresql_schema.sql            # PostgreSQL schema definition
│   ├── add_backup_to_deployment.py      # Add backup to deployment history
│   ├── mount_s3fs.py                    # S3 filesystem mounting
│   ├── generate_ssl.sh                  # SSL certificate generation
│   ├── setup_letsencrypt.sh             # Let's Encrypt SSL setup
│   ├── ovh_infrastructure.tf            # Terraform IaC for OVHcloud
│   ├── terraform.tfvars.example         # Terraform variables example
│   ├── deploy_example_service.sh        # Service deployment example
│   ├── sso_client_example.py            # SSO client example
│   └── swautomorph-controlplan.service  # Systemd service file
├── tests/                # Test suite (pytest)
│   ├── test_serverless_routes.py        # Serverless API tests
│   ├── test_worker.py                   # Worker process tests
│   ├── test_worker_main.py              # Worker main entry point tests
│   ├── test_worker_logging.py           # Worker logging tests
│   ├── test_container_runtime.py        # Container runtime tests
│   ├── test_log_cleanup.py              # Log cleanup tests
│   ├── test_gpu_parsers.py              # MIG instance parser tests
│   ├── test_parse_mig_profiles.py       # MIG profile parser tests
│   ├── test_validate_profile_ids.py     # Profile ID validation tests
│   ├── test_gpu_enabled_endpoint.py     # GPU enabled toggle tests
│   └── test_gpu_delete_instances.py     # GPU instance destruction tests
├── templates/            # HTML templates with EN/FR support
│   ├── base.html                 # Base layout with navigation
│   ├── dashboard.html            # Main dashboard
│   ├── shared_gpu.html           # MIG GPU management page
│   ├── login.html                # Login page
│   ├── register.html             # Registration page
│   ├── password_reset.html       # Password reset form
│   ├── sso_login.html            # SSO login page
│   ├── docs.html                 # Documentation listing
│   ├── doc_viewer.html           # Markdown doc viewer
│   └── dashboard_functions.js    # Dashboard JavaScript
├── conf/                 # Configuration files
│   ├── deploy.ini                # Main platform configuration
│   └── serverless.ini            # Serverless worker configuration
├── static/               # CSS, JS, and static files
├── ssl/                  # SSL certificates
├── logs/                 # Application logs with rotation
├── shared/               # Context files for virtual agents
├── docs/                 # Documentation
├── init_pltf.sh          # Platform initialization (Docker, NVIDIA, MIG)
├── deployControlPlan.sh  # Main deployment script
├── wsgi.py               # WSGI entry point for Gunicorn
├── requirements.txt      # Python dependencies
└── Dockerfile.postgres   # PostgreSQL Docker configuration
```

### Key Components

- **Flask Application**: Multi-blueprint architecture (11 blueprints) with modular routes and virtual AI agents
- **Database**: **PostgreSQL with connection pooling** for enterprise-grade performance and thread-safe operations
- **Authentication**: Session-based with SSO token support, password reset, and two-factor authentication (TOTP + email)
- **Deployment**: Multi-server support with capacity management, automatic allocation, and streaming APIs
- **App Orchestrator**: Automated application lifecycle management with reconciliation loop (30s interval), multi-user deployment, and health checks
- **Serverless Execution**: Docker-based job submission with remote opcp-serverless-brik dispatching, `FOR UPDATE SKIP LOCKED` queue, cancellation support, and worker processes
- **MIG Shared GPU**: NVIDIA Multi-Instance GPU partitioning via SSH with per-server configuration, web UI, and database tracking
- **Replication**: Event-driven peer-to-peer database replication with version-based conflict resolution, retry logic, and sync tokens
- **Platform Discovery**: Automatic multi-server role detection (PRIMARY/SECONDARY) with remote status checks
- **Nginx Proxy**: Dynamic location blocks for user applications with automatic configuration and orchestrator-generated upstreams
- **Security**: ModSecurity WAF with OWASP CRS rules, password reset via email, TOTP 2FA with backup codes, email-based 2FA
- **Email Service**: SMTP-based notifications for password reset links and 2FA verification codes
- **Monitoring**: Health checks, database statistics, real-time streaming logs, orchestrator status, and job metrics
- **Virtual AI Agents**: AI Chat Developer and Operations assistants with context-aware prompts (kiro-cli, qchat, shai engines)
- **Billing System**: Comprehensive cost tracking with activity logging, usage monitoring, PDF invoice generation, and period filtering
- **Multi-language**: English/French support with session-based language switching and bilingual documentation
- **Backup System**: Automated hourly backups with S3 sync, interactive recovery tools, and per-deployment JSONB history tracking
- **Infrastructure as Code**: Terraform templates for OVHcloud provisioning (servers, networking)
- **Platform Init**: Automated server provisioning including Docker, NVIDIA drivers, MIG mode, Kiro CLI, and Terraform setup

### Python Dependencies

```
Flask
Werkzeug
click
requests
Flask-CORS
simple-term-menu
gunicorn
psycopg2-binary
python-dotenv
pyotp
```

## Troubleshooting

### Common Issues
```bash
# Check service status
./deployControlPlan.sh ps

# View detailed logs
./deployControlPlan.sh logs

# Port conflicts
sudo netstat -tulpn | grep -E ':(80|443|3000|5000)'

# Permission issues
sudo chown -R ubuntu:ubuntu /home/ubuntu/deployments/
sudo chown -R ubuntu:ubuntu /home/ubuntu/<PLTF_FOLDER>/

# Database issues
python3 ./scripts/aipoweredstore_cli.py db-health
./deployControlPlan.sh --recover_db

# SSL certificate issues
./scripts/generate_ssl.sh
./scripts/setup_letsencrypt.sh

# Replication issues
curl https://opcp-psmc.com/api/sync/health
curl https://opcp-psmc.com/api/sync/status

# Serverless worker issues
journalctl -u serverless-worker.service -f
python3 -m src.serverless.worker  # Run manually for debugging
```

### Reset Installation
```bash
# Stop all services
./deployControlPlan.sh stop

# Complete reset (Docker)
docker-compose down -v
docker system prune -f

# Complete reset (Local)
sudo systemctl stop nginx gitea
sudo rm -rf /etc/nginx/sites-enabled/<PLTF_FOLDER>

# Restart deployment
./deployControlPlan.sh start
```

### Debug Mode
```bash
# Enable debug logging
export FLASK_DEBUG=1
export FLASK_ENV=development

# Run with verbose output
./deployControlPlan.sh start locally 2>&1 | tee deployment.log
```
