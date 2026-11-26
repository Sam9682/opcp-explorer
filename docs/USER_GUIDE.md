# OPCP-explorer User Guide

This guide explains how to use the OPCP-explorer web dashboard. The name shown in the
navigation bar is configurable (`PLTF_NAME` in `conf/deploy.ini`, default
`agentic-ai-plateform`), so your instance may display a different name.

In the examples, `https://<DOMAIN>` is the address of your platform.

Related documents: [Platform Overview](PLATFORM_OVERVIEW.md) ·
[Architecture Guide](ARCHITECTURE_GUIDE.md) · [Deployment Guide](DEPLOYMENT_GUIDE.md) ·
[API Reference](API_REFERENCE.md) · [Serverless](SERVERLESS.md) ·
[Available Applications](LIST_OF_APP_AVAILABLE.md)

---

## Contents

1. [Accounts and sign-in](#1-accounts-and-sign-in)
2. [Account security: password and 2FA](#2-account-security-password-and-2fa)
3. [Navigation and language](#3-navigation-and-language)
4. [Applications tab](#4-applications-tab)
5. [Virtual AI agents](#5-virtual-ai-agents)
6. [MAKE App. Compliant](#6-make-app-compliant)
7. [Serverless tab](#7-serverless-tab)
8. [Marketplace tab](#8-marketplace-tab)
9. [Sandbox tab](#9-sandbox-tab)
10. [Billing tab](#10-billing-tab)
11. [Administration (admin only)](#11-administration-admin-only)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Accounts and sign-in

### Register

1. Open `https://<DOMAIN>/` and click the **register** link under the login form
   (or go to `https://<DOMAIN>/register`).
2. Fill in username (letters and digits only), email, optional first and last name,
   and password (entered twice).
3. Submit. The account is created **suspended**: you cannot sign in until an
   administrator unsuspends it from the **Users** page.

### Sign in

1. Enter your username and password on the login page.
2. If two-factor authentication (2FA) is enabled on your account, a second step
   appears. Choose **Authenticator App** or **Email Code** (only the methods you have
   enabled are shown), enter the code and click **Verify**.
3. You land on the dashboard (`/dashboard`).

Sign-in fails if the password is wrong or if the account is suspended.

At sign-in the platform also issues an SSO token, valid for one week. The platform
uses it to sign you in to deployed applications that support it (see
[API Reference](API_REFERENCE.md), `/sso/*` endpoints).

**Log out** with the link at the right of the navigation bar.

---

## 2. Account security: password and 2FA

Open the 🔐 icon in the navigation bar. Every signed-in user has this tab.

### Change password

Enter your current password, then the new password twice (minimum 6 characters), and
click **Change password**.

### Reset password by email

On the same form, **Reset via email** sends a reset link to the address on your
account. The link is valid for **1 hour** and opens `/security/password-reset/<token>`,
where you choose a new password.

The login page has no "forgot password" link. If you cannot sign in, ask an
administrator to use **Reset Password** on the Users page, which sends you the same
email. If email delivery fails (SMTP not configured), the administrator sees the reset
link and can pass it to you.

### Two-factor authentication

- **Authenticator app (TOTP).** Click **Set up authenticator** and scan the QR code
  with an app such as Google Authenticator, Authy or FreeOTP. Enter a code to confirm.
  You then get **8 single-use backup codes**. Store them safely: each one can replace an
  authenticator code once at login.
- **Email verification.** Click **Enable email 2FA**. At each login a code is emailed
  to you, valid for **5 minutes**.
- **Disable 2FA.** Enter your password and click **Disable 2FA**. This turns off both
  methods. An administrator can also disable 2FA for a user from the Users page.

---

## 3. Navigation and language

The top navigation bar contains:

| Item | Who | Purpose |
|------|-----|---------|
| Applications | everyone | Your applications and their lifecycle buttons |
| 🚀 Serverless | everyone | Submit and monitor serverless Docker jobs |
| 🛒 Marketplace | everyone | Deploy ready-made templates |
| 🧪 Sandbox | everyone | Demo environment |
| Billing | everyone | Usage, costs and invoices |
| 🔐 | everyone | Account security |
| Configuration ▼ | admins | Users, Servers, Applications Management, Deployments Management, Orchestrator, Database Management, Settings |
| Help ▼ | everyone | Architecture Guide, Deployment Guide, User Guide, Available Applications, Serverless, Share GPU Docker, Platform Overview |

- **Language:** the **EN** / **FR** buttons at the right switch the interface
  language. Your choice is kept in your session. The dashboard defaults to French until
  you choose a language.
- **Layout:** the 🖥️ / 📱 button switches the dashboard between vertical and
  horizontal layouts (where the virtual agents panel sits).
- **Mobile:** on narrow screens the ☰ button opens the same menu.

---

## 4. Applications tab

### What you see

The **Applications** table lists the applications assigned to you. Each row shows:

- ID, name and description;
- **Gitea branch**: a drop-down of the branches you can clone (the original repository
  and the branches created by the Virtual Developer);
- **Local active version**: the version currently cloned for you;
- action buttons.

If you are not an administrator, a second table, **Available applications**, lists
applications that exist on the platform but are not assigned to you (🔒). Use 👁️ to view
their details, and ask an administrator to assign the ones you need.

### Action buttons

All users see every lifecycle button on applications assigned to them:

| Button | Action |
|--------|--------|
| 🔗 Open | Opens the application URL in a new tab |
| 📥 Clone | Clones the branch selected in the **Gitea branch** drop-down |
| ▶️ Start | Runs `deployApp.sh start` for your copy |
| ⏹️ Stop | Runs `deployApp.sh stop` |
| 🔄 Restart | Runs `deployApp.sh restart` |
| 📊 | Status (`ps`) |
| 📋 | Logs |
| 💾 / ♻️ | Database backup / restore. 💾 is shown while the application is running |
| 👁️ | View details (non-admins) |
| ✏️ / 🗑️ | Edit / delete the application (admins only) |

The Clone and lifecycle buttons only appear if the application has a Git repository
URL. Each operation shows a progress pop-up with an estimated duration and streams its
output.

### Deploying an application, step by step

1. **Choose a branch** in the **Gitea branch** column.
2. Click **📥 Clone**. The platform picks a server, clones the repository with its
   submodules into
   `/home/<LINUX_USER_INSTALLATION>/deployments/<your-username>/<application-name>`,
   copies the SSL certificates and adds an nginx route for your copy.
3. Click **▶️ Start**. The platform runs the application's `deployApp.sh start` script
   in your copy, with your user ID, name and email. The container runtime chosen by the
   administrator (`runc` or `kata`) is passed to the script.
4. When the application is running, the **Open** button becomes active.
5. Use **📊** for status, **📋** for logs, and **⏹️ Stop** when you are done.

The dashboard checks each cloned application's status and adjusts the buttons:

| State | Meaning |
|-------|---------|
| Not cloned | No copy yet: use Clone |
| Cloned, running | Open is active; Stop / Restart / PS / Logs available |
| Cloned, not running | Start available |
| ⚠️ Not Compliant | Cloned, but the repository has no `deployApp.sh` (see [section 6](#6-make-app-compliant)) |

### Application URL

Each user gets their own copy of an application, reachable at:

```
https://<DOMAIN>/<username>/<application-name>/
```

Administrators can see this URL in the read-only field of the application edit form.
Each copy gets 12 consecutive ports (6 HTTPS and 6 HTTP), calculated from your user ID
and the application ID, and nginx proxies the URL above to those ports.

---

## 5. Virtual AI agents

The **Virtual Agents** panel sits next to the dashboard. Use **−** to collapse it.

1. Select one of your applications in the first drop-down. Only cloned applications can
   be used.
2. Select an action in the second drop-down. The available actions depend on the state
   of the application:

   | Application state | Actions offered |
   |-------------------|-----------------|
   | Running | STOP, PS, LOGS, MODIFY_CODE, SPECIFY, BACKUP Database |
   | Not running | START, LOGS, MODIFY_CODE, SPECIFY, RESTORE Database |
   | Not compliant | MAKE App. Compliant, LOGS |
   | Not cloned | none |

3. The text box is filled in with a request for that action. For MODIFY_CODE and SPECIFY,
   add a plain-language description of what you want.
4. Click **Send**. The agent's output streams into the panel.

The agents fall into two groups:

- **Virtual Developer** (MODIFY_CODE, SPECIFY). It runs an AI coding engine in your
  copy of the application. SPECIFY produces a detailed specification. MODIFY_CODE changes
  the code. After a successful MODIFY_CODE run, the change is pushed to a new Gitea
  branch named `<user_id>-automorph-<application>-<timestamp>`, which then appears in
  the **Gitea branch** drop-down. Runs stop after 30 minutes.
- **Virtual Operations** (START, STOP, PS, LOGS, backup/restore, MAKE App. Compliant).
  It runs the operation through the AI engine, using an action-specific prompt. START and
  STOP requests sent through the agent are also recorded for billing. If the request
  does not match a known action, the agent answers it as a question and does not run
  anything.

The AI engine (`kiro-cli`/`qchat` by default, or `shai`) is chosen by the
administrator in **Settings**. For prompts, context files and API details, see
`docs/technicals/VIRTUAL_AGENTS.md`.

---

## 6. MAKE App. Compliant

To run on the platform, an application must have a `deployApp.sh` script at the root of
its repository. The script must handle `start`, `stop`, `restart`, `ps` and `logs`, and
accept the user ID, user name, user email and runtime type arguments
(see [Architecture Guide](ARCHITECTURE_GUIDE.md)).

If you clone a repository without this script:

1. Its row shows a disabled **⚠️ Not Compliant** button instead of **Open**. Clone and
   Logs stay available.
2. Select the application in the Virtual Agents panel. The action list offers
   **MAKE App. Compliant** and **LOGS**.
3. Choose **MAKE App. Compliant**. The text box is filled with:
   `I need an operations specialist to execute the [[MAKE_APP_COMPLIANT]] action on the application <app>`.
4. Click **Send**. The Virtual Operations agent receives the request.

Whether the agent actually generates a `deployApp.sh` depends on your installation: it
needs a `MAKE_APP_COMPLIANT_context.md` prompt file in the platform's `shared/` folder.
Without that file, the agent only answers the request as a question and creates nothing.
Once a `deployApp.sh` is in the repository, clone again. The application then shows the
normal Start/Stop buttons.

---

## 7. Serverless tab

Run a one-off Docker job without deploying an application.

1. **Target endpoint**: choose one of the running `opcp-serverless-*` endpoints listed
   at the top of the tab. The list is empty if no serverless endpoint application is
   running.
2. **Image**: a container image from an allowed registry, for example
   `python:3.11-slim`.
3. **Command**: one command per line.
4. Optional: **environment variables** (JSON) and a **timeout** in seconds.
5. Click **Submit Job**.

The **Jobs** list shows each job's state (`pending`, `running`, `completed`, `failed`,
`timeout`, `cancelled`). Open a job to see its stdout and stderr, or cancel it.
**Metrics** shows queue statistics (administrators only). See [Serverless](SERVERLESS.md) for limits and the
API.

---

## 8. Marketplace tab

The Marketplace lists the deploy templates enabled on the platform. The default catalog
contains `static-site`, `fastapi-starter`, `n8n`, `ollama`, `jupyter` and `vector-db`
(Qdrant).

Choose a template, enter an application name and deploy. The platform registers the
application for you, allocates its ports and adds the nginx route. The CLI, the MCP
server and the REST API (`POST /api/templates/<template_id>/deploy`) use the same
deployment service.

---

## 9. Sandbox tab

The sandbox is a demo environment for trying the platform without affecting real users.

- **Provision** creates a dedicated demo user (account type `sandbox demo`) and deploys
  3 to 10 sample applications from the template catalog. If any step fails, everything
  it created is removed. The API response (`POST /api/sandbox/provision`) contains the
  demo credentials and one access URL per application. The tab itself only shows the
  resulting status.
- **Reset** removes the sample applications and deploys them again.
- **Teardown** removes the sample applications, the demo user and their records.
- **Status** shows whether a sandbox exists and the state of each sample application.

Only resources marked as sandbox are affected.

---

## 10. Billing tab

The Billing tab has two sub-tabs for all users, plus a third for administrators.

- **Overview**: choose a period (today, this week, this month, previous month) to see a
  **usage summary** (time and cost per application) and an **activity log** of
  start/stop events. Administrators can also filter by user.
- **Invoices**: lists your invoices. Each one can be downloaded as a PDF. If you have
  unpaid invoices, a **Payment Required** pop-up appears once per browser session.
  Administrators can generate an invoice for a user and month, and mark invoices as paid.
- **Manage costs** (admins only): sets the daily rate of each application.

Cost of a run = daily rate × running time (seconds) ÷ 86,400. A run is measured from a
START to the matching STOP. Applications without a configured rate are billed at 1.0 per
day.

---

## 11. Administration (admin only)

A user has administrator rights if their username is `admin` (the built-in super admin)
or their account type is `ADMIN`. Administrators see the **Configuration ▼** menu, the
✏️/🗑️ buttons on applications, the **Add new application** button and the admin-only
billing features.

### Users

- Create, edit and delete users.
- **Apps**: assign applications to a user or remove them.
- **Suspend / Unsuspend**. New self-registered accounts must be unsuspended here.
- **Reset Password** emails a reset link to the user.
- **Disable 2FA** (shown when the user has 2FA enabled).
- **ADMIN / Revoke ADMIN**: grants or removes administrator rights (sets the account type
  to `ADMIN`). Only the `admin` user sees this button. It is not offered for `admin`
  itself or for accounts with another account type, such as sandbox demo users. Users
  with administrator rights show an **ADMIN** badge.

### Servers

The Servers page lists the servers that host deployments. You can:

- **Invite server** to add one. **🔍 DISCOVER** fills in its details automatically.
- Set its status: `STAND_BY`, `ACTIVE`, `STAND_ALONE`, `PRIMARY` or `SECONDARY`.
- Run **Synchronization**, **Promote PRIMARY** or **Promote SECONDARY** for multi-server
  replication. See `docs/technicals/REPLICATION.md`.
- Open **Shared-GPU** to manage NVIDIA MIG partitions. See
  [Share GPU Docker](SHARE_GPU_DOCKER.md).

### Applications Management

Add, edit or delete catalog applications. Each application has a name, URL,
description, Git repository URL, repository size, and estimated build/start/stop/ps
durations, which the progress pop-ups use. **Download PDF** exports the list.

### Deployments Management

A table of every user's deployments. Filter by user, application or status. Each row
shows its modification history (Virtual Developer branches) and backup history. Row
actions: edit, delete, and **🔄 Update Nginx** to regenerate that deployment's route.
See `docs/technicals/BACKUP_AND_RECOVERY.md` and `docs/technicals/NGINX_AND_DOMAINS.md`.

### Orchestrator

Create replicated services from an application's Git URL, with a desired replica count,
environment variables (JSON) and a health check path. There are two deployment modes:
one Docker replica per available server, or replica users on the current server. The page
also shows services and their instances, and has **Generate Config** and **Reload Nginx**
buttons. See `docs/technicals/ORCHESTRATOR.md`.

### Database Management

Browse and edit the main tables directly (users, applications, user_applications,
deployments, servers, instances, services, costs, billing, logs, payment modes,
invoicing): refresh, add, edit and delete records. Use with care. See
`docs/technicals/DATABASE.md`.

### Settings

- **Container Runtime Type**: `runc` (default, standard Docker containers) or `kata`
  (each container in a Kata Containers MicroVM, for stronger isolation). It applies to
  application deployments and serverless jobs. Serverless workers read it when they
  start, so restart them after a change.
- **Configuration parameters**: a key/value table (with an optional parent key). The
  default keys are:
  - `agentic_engine`: AI engine for the virtual agents (default `kiro-cli`; `shai` is
    also supported);
  - `agentic_command`: if set, agent requests run
    `deployControlPlan.sh <agentic_command>` instead of the AI engine;
  - `runtime_type`: the same value as the selector above.

---

## 12. Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Cannot sign in after registering | New accounts are suspended. Ask an administrator to unsuspend you. |
| Lost authenticator device | Use one of your backup codes, or ask an administrator to disable 2FA. |
| Reset email never arrives | SMTP settings (`SMTP_*` environment variables) on the server. An administrator can get the reset link from the Users page. |
| No Clone/Start buttons on an application | The application has no Git URL. Ask an administrator. |
| ⚠️ Not Compliant | The repository lacks `deployApp.sh`. See [section 6](#6-make-app-compliant). |
| Open button stays disabled | The application is not running. Check 📊 status and 📋 logs, then Start. |
| Application URL returns 404/502 | The application is stopped or its nginx route is stale. An administrator can use **🔄 Update Nginx** in Deployments Management. |
| Agent says the application must be cloned first | Clone it from the Applications tab. |
| Agent answers as an advisor instead of acting | The action has no prompt file in `shared/`, or the request is not a recognized action. |
| Serverless target list is empty | No `opcp-serverless-*` application is running. Start one. |
| Interface in the wrong language | Click EN or FR in the navigation bar. |

Administrators can find server-side logs in the platform's `logs/` folder
(`gunicorn_error.log`, `api_routes.log`, `genai_routes.log`, `serverless_worker.log`,
and others). See section 8, Logging, of the [Architecture Guide](ARCHITECTURE_GUIDE.md).
