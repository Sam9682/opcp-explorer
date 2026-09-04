/**
 * Auto-refresh timer for the serverless job list.
 * Active only when the orchestratorServerless tab is visible.
 */
let serverlessRefreshInterval = null;

/**
 * Start auto-refreshing the serverless job list every 5 seconds.
 * Clears any existing interval before starting a new one.
 */
function startServerlessAutoRefresh() {
    stopServerlessAutoRefresh();
    // Load available links on tab activation
    loadServerlessLinks();
    serverlessRefreshInterval = setInterval(function() {
        refreshJobList();
        loadServerlessMetrics();
        loadServerlessLinks();
    }, 5000);
}

/**
 * Stop the auto-refresh timer for the serverless job list.
 */
function stopServerlessAutoRefresh() {
    if (serverlessRefreshInterval !== null) {
        clearInterval(serverlessRefreshInterval);
        serverlessRefreshInterval = null;
    }
}

/**
 * Load available opcp-serverless-brik endpoint links into the target dropdown
 * and display them in the links panel with availability status.
 * Preserves the currently selected value in the dropdown.
 */
async function loadServerlessLinks() {
    const select = document.getElementById('serverlessTargetLink');
    const linksContent = document.getElementById('serverlessLinksContent');

    // Preserve current selection before rebuilding
    const previousSelection = select ? select.value : '';

    try {
        const response = await fetch('/api/serverless-links', {
            method: 'GET',
            credentials: 'same-origin'
        });

        if (!response.ok) {
            if (select) select.innerHTML = '<option value="">-- Failed to load links --</option>';
            if (linksContent) linksContent.innerHTML = '<p style="color:red;">Failed to load endpoints.</p>';
            return;
        }

        const data = await response.json();
        const endpoints = data.endpoints || [];
        const links = data.links || [];

        if (endpoints.length === 0 && links.length === 0) {
            if (select) select.innerHTML = '<option value="">-- No endpoints available --</option>';
            if (linksContent) linksContent.innerHTML = '<p style="color:orange;">No opcp-serverless-* endpoints are currently running. Please start an endpoint or contact your administrator.</p>';
            return;
        }

        // Use endpoints (with status) if available, otherwise fall back to flat links
        if (endpoints.length > 0) {
            // Populate dropdown with status indicators
            if (select) {
                let selectHtml = '<option value="">-- Select target endpoint --</option>';
                for (const ep of endpoints) {
                    const statusLabel = ep.status === 'AVAILABLE' ? '✅' : ep.status === 'OCCUPIED' ? '🔒' : '❓';
                    const disabled = ep.status === 'OCCUPIED' ? ' disabled' : '';
                    const selected = (ep.url === previousSelection) ? ' selected' : '';
                    selectHtml += '<option value="' + ep.url + '"' + disabled + selected + '>' + statusLabel + ' ' + ep.url + ' (' + ep.username + ') - ' + ep.status + '</option>';
                }
                select.innerHTML = selectHtml;
            }

            // Populate links panel with status badges (only running endpoints from backend)
            if (linksContent) {
                let panelHtml = '<p style="font-size:12px; color:#666; margin:0 0 8px 0;"><em>Showing only running opcp-serverless-* endpoints</em></p>';
                panelHtml += '<table style="width:100%; border-collapse:collapse;">';
                panelHtml += '<tr style="border-bottom:1px solid #ddd;"><th style="text-align:left; padding:5px;">Endpoint</th><th style="text-align:left; padding:5px;">App</th><th style="text-align:left; padding:5px;">Owner</th><th style="text-align:left; padding:5px;">Status</th></tr>';
                for (const ep of endpoints) {
                    let statusBadge;
                    if (ep.status === 'AVAILABLE') {
                        statusBadge = '<span style="background:#28a745; color:#fff; padding:2px 8px; border-radius:3px; font-size:12px;">✅ AVAILABLE</span>';
                    } else if (ep.status === 'OCCUPIED') {
                        statusBadge = '<span style="background:#dc3545; color:#fff; padding:2px 8px; border-radius:3px; font-size:12px;">🔒 OCCUPIED</span>';
                    } else {
                        statusBadge = '<span style="background:#6c757d; color:#fff; padding:2px 8px; border-radius:3px; font-size:12px;">❓ UNKNOWN</span>';
                    }
                    const appName = ep.app_name || 'opcp-serverless-brik';
                    panelHtml += '<tr style="border-bottom:1px solid #eee;">';
                    panelHtml += '<td style="padding:5px;"><a href="' + ep.url + '" target="_blank" style="color:#007bff; text-decoration:none;">' + ep.url + '</a></td>';
                    panelHtml += '<td style="padding:5px;">' + appName + '</td>';
                    panelHtml += '<td style="padding:5px;">' + ep.username + '</td>';
                    panelHtml += '<td style="padding:5px;">' + statusBadge + '</td>';
                    panelHtml += '</tr>';
                }
                panelHtml += '</table>';
                linksContent.innerHTML = panelHtml;
            }
        } else {
            // Fallback: use flat links without status
            if (select) {
                let selectHtml = '<option value="">-- Select target endpoint --</option>';
                for (const link of links) {
                    const selected = (link === previousSelection) ? ' selected' : '';
                    selectHtml += '<option value="' + link + '"' + selected + '>' + link + '</option>';
                }
                select.innerHTML = selectHtml;
            }
            if (linksContent) {
                let panelHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
                for (const link of links) {
                    panelHtml += '<li style="margin-bottom: 5px;"><a href="' + link + '" target="_blank" style="color:#007bff; text-decoration:none;">🌐 ' + link + '</a></li>';
                }
                panelHtml += '</ul>';
                linksContent.innerHTML = panelHtml;
            }
        }
    } catch (err) {
        if (select) select.innerHTML = '<option value="">-- Error loading links --</option>';
        if (linksContent) linksContent.innerHTML = '<p style="color:red;">Network error: ' + err.message + '</p>';
    }
}

/**
 * Submit a serverless Docker job via POST /api/jobs.
 * Reads form inputs, builds the payload, and refreshes the job list on success.
 */
async function submitServerlessJob() {
    const targetLink = document.getElementById('serverlessTargetLink').value;
    const image = document.getElementById('serverlessImage').value.trim();
    const commandStr = document.getElementById('serverlessCommand').value.trim();
    const envStr = document.getElementById('serverlessEnv').value.trim();
    const timeoutStr = document.getElementById('serverlessTimeout').value.trim();

    // Validate required fields
    if (!targetLink) {
        alert('Error: You must select a target endpoint.');
        return;
    }
    if (!image) {
        alert('Error: Docker image is required.');
        return;
    }
    if (!commandStr) {
        alert('Error: Command is required.');
        return;
    }

    // Parse command: each line is a separate command entry
    // Split by newlines, trim each line, filter out empty lines
    const lines = commandStr.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    const command = lines;

    // Build the request payload
    const payload = {
        image: image,
        command: command,
        target_link: targetLink
    };

    // Parse environment variables JSON if provided
    if (envStr) {
        try {
            const env = JSON.parse(envStr);
            payload.env = env;
        } catch (e) {
            alert('Error: Environment variables must be valid JSON.\n' + e.message);
            return;
        }
    }

    // Include timeout if provided
    if (timeoutStr) {
        const timeout = parseInt(timeoutStr, 10);
        if (isNaN(timeout) || timeout < 1 || timeout > 3600) {
            alert('Error: Timeout must be between 1 and 3600 seconds.');
            return;
        }
        payload.timeout = timeout;
    }

    try {
        const response = await fetch('/api/jobs', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const data = await response.json();
            alert('Job submitted successfully! Job ID: ' + data.job_id);
            // Reset the form
            document.getElementById('serverlessJobForm').reset();
            // Re-load links after form reset (reset clears the dropdown)
            loadServerlessLinks();
            // Refresh the job list
            if (typeof refreshJobList === 'function') {
                refreshJobList();
            }
        } else {
            const errorData = await response.json().catch(() => null);
            const errorMsg = errorData && errorData.error ? errorData.error : 'HTTP ' + response.status;
            alert('Failed to submit job: ' + errorMsg);
        }
    } catch (err) {
        alert('Network error submitting job: ' + err.message);
    }
}

function formatRepoSize(sizeInMB) {
    if (sizeInMB < 10) {
        return `Small (${sizeInMB}MB)`;
    } else if (sizeInMB < 100) {
        return `Medium (${sizeInMB}MB)`;
    } else if (sizeInMB < 1000) {
        return `Large (${sizeInMB}MB)`;
    } else {
        return `Very Large (${(sizeInMB/1000).toFixed(1)}GB)`;
    }
}

function startCloneProgressSimulation(repoSizeMB) {
    let progress = 0;
    let startTime = Date.now();
    
    // Calculate estimated duration based on actual repo size
    let estimatedDuration;
    if (repoSizeMB < 10) {
        estimatedDuration = 15 + (repoSizeMB * 1.5); // 15-30 seconds
    } else if (repoSizeMB < 100) {
        estimatedDuration = 30 + (repoSizeMB * 0.8); // 30-110 seconds
    } else if (repoSizeMB < 1000) {
        estimatedDuration = 120 + (repoSizeMB * 0.3); // 2-7 minutes
    } else {
        estimatedDuration = 300 + (repoSizeMB * 0.1); // 5+ minutes
    }
    
    // Set initial estimated time
    document.getElementById('estimatedTime').textContent = formatDuration(Math.round(estimatedDuration));
    
    const progressInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('elapsedTime').textContent = elapsed + 's';
        
        // Simulate realistic progress curve (slower at start, faster in middle, slower at end)
        const timeRatio = elapsed / estimatedDuration;
        if (timeRatio < 0.1) {
            progress = timeRatio * 50; // 0-5% in first 10% of time
        } else if (timeRatio < 0.8) {
            progress = 5 + (timeRatio - 0.1) * 128.57; // 5-95% in next 70% of time
        } else {
            progress = 95 + (timeRatio - 0.8) * 25; // 95-100% in last 20% of time
        }
        
        progress = Math.min(progress, 99); // Never reach 100% until actually done
        
        const progressBar = document.getElementById('cloneProgress');
        const progressText = document.getElementById('progressText');
        
        if (progressBar) {
            progressBar.style.width = progress + '%';
        }
        
        if (progressText) {
            if (progress < 10) {
                progressText.textContent = 'Connecting to repository...';
            } else if (progress < 30) {
                progressText.textContent = 'Downloading repository metadata...';
            } else if (progress < 70) {
                progressText.textContent = 'Cloning files and history...';
            } else if (progress < 90) {
                progressText.textContent = 'Processing repository structure...';
            } else {
                progressText.textContent = 'Finalizing clone operation...';
            }
        }
        
        // Update estimated time remaining
        const remaining = Math.max(0, estimatedDuration - elapsed);
        if (remaining > 0) {
            document.getElementById('estimatedTime').textContent = formatDuration(remaining) + ' remaining';
        }
        
    }, 1000);
    
    // Store interval ID to clear it later
    window.cloneProgressInterval = progressInterval;
}


/**
 * Refresh the serverless jobs list by fetching from GET /api/jobs
 * and rendering the job table with status badges and action buttons.
 */
async function refreshJobList() {
    const tbody = document.getElementById('serverlessJobsBody');
    if (!tbody) return;

    try {
        const response = await fetch('/api/jobs', {
            method: 'GET',
            credentials: 'same-origin'
        });

        if (!response.ok) {
            tbody.innerHTML = '<tr><td colspan="6">Failed to load jobs (HTTP ' + response.status + ')</td></tr>';
            return;
        }

        const data = await response.json();
        const jobs = data.jobs || [];

        if (jobs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">No jobs found</td></tr>';
            return;
        }

        let html = '';
        for (const job of jobs) {
            const createdAt = job.created_at ? new Date(job.created_at).toLocaleString() : 'N/A';
            const statusBadge = '<span class="job-status-badge status-' + job.status + '">' + job.status + '</span>';
            const targetLink = job.target_link || 'N/A';

            let actions = '<button class="btn btn-secondary btn-small" onclick="viewJobDetail(\'' + job.job_id + '\')">View</button>';
            if (job.status === 'pending' || job.status === 'running') {
                actions += ' <button class="btn btn-danger btn-small" onclick="cancelJob(\'' + job.job_id + '\')">Cancel</button>';
            }

            html += '<tr>';
            html += '<td>' + job.job_id + '</td>';
            html += '<td>' + job.image + '</td>';
            html += '<td><a href="' + targetLink + '" target="_blank" style="color:#007bff;">' + targetLink + '</a></td>';
            html += '<td>' + statusBadge + '</td>';
            html += '<td>' + createdAt + '</td>';
            html += '<td>' + actions + '</td>';
            html += '</tr>';
        }

        tbody.innerHTML = html;
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6">Network error loading jobs: ' + err.message + '</td></tr>';
    }
}

/**
 * View job detail by fetching job status and result from the API,
 * then displaying the information in the detail panel.
 * @param {string} jobId - The UUID of the job to view
 */
async function viewJobDetail(jobId) {
    const detailPanel = document.getElementById('serverlessJobDetail');
    const detailContent = document.getElementById('serverlessJobDetailContent');

    if (!detailPanel || !detailContent) return;

    // Show the panel and indicate loading
    detailPanel.style.display = 'block';
    detailContent.innerHTML = '<p>Loading job details...</p>';

    try {
        // Fetch job status
        const statusResponse = await fetch('/api/jobs/' + jobId, {
            method: 'GET',
            credentials: 'same-origin'
        });

        if (!statusResponse.ok) {
            const errData = await statusResponse.json().catch(() => null);
            const errMsg = errData && errData.error ? errData.error : 'HTTP ' + statusResponse.status;
            detailContent.innerHTML = '<p style="color:red;">Failed to load job details: ' + errMsg + '</p>';
            return;
        }

        const job = await statusResponse.json();

        // Build job metadata HTML
        let html = '<table class="job-detail-table" style="width:100%; border-collapse:collapse; margin-bottom:15px;">';
        html += '<tr><td><strong>Job ID:</strong></td><td>' + (job.job_id || jobId) + '</td></tr>';
        html += '<tr><td><strong>Status:</strong></td><td><span class="job-status-badge status-' + job.status + '">' + job.status + '</span></td></tr>';
        html += '<tr><td><strong>Image:</strong></td><td>' + (job.image || 'N/A') + '</td></tr>';
        html += '<tr><td><strong>Created:</strong></td><td>' + (job.created_at ? new Date(job.created_at).toLocaleString() : 'N/A') + '</td></tr>';
        html += '<tr><td><strong>Started:</strong></td><td>' + (job.started_at ? new Date(job.started_at).toLocaleString() : 'N/A') + '</td></tr>';
        html += '<tr><td><strong>Completed:</strong></td><td>' + (job.completed_at ? new Date(job.completed_at).toLocaleString() : 'N/A') + '</td></tr>';
        html += '<tr><td><strong>Exit Code:</strong></td><td>' + (job.exit_code !== null && job.exit_code !== undefined ? job.exit_code : 'N/A') + '</td></tr>';
        html += '<tr><td><strong>Worker:</strong></td><td>' + (job.worker_id || 'N/A') + '</td></tr>';
        html += '</table>';

        // If job is in a terminal state, fetch the result
        const terminalStates = ['completed', 'failed', 'timeout', 'cancelled'];
        if (terminalStates.includes(job.status)) {
            try {
                const resultResponse = await fetch('/api/jobs/' + jobId + '/result', {
                    method: 'GET',
                    credentials: 'same-origin'
                });

                if (resultResponse.ok) {
                    const result = await resultResponse.json();

                    html += '<h4 style="margin-top:10px;">Result</h4>';
                    html += '<p><strong>Exit Code:</strong> ' + (result.exit_code !== null && result.exit_code !== undefined ? result.exit_code : 'N/A') + '</p>';

                    if (result.stdout) {
                        html += '<h5>Stdout:</h5>';
                        html += '<pre style="background:#1e1e1e; color:#d4d4d4; padding:10px; border-radius:4px; overflow-x:auto; max-height:300px; overflow-y:auto;">' + escapeHtml(result.stdout) + '</pre>';
                    }

                    if (result.stderr) {
                        html += '<h5>Stderr:</h5>';
                        html += '<pre style="background:#2d1515; color:#f48771; padding:10px; border-radius:4px; overflow-x:auto; max-height:300px; overflow-y:auto;">' + escapeHtml(result.stderr) + '</pre>';
                    }

                    if (result.result && Object.keys(result.result).length > 0) {
                        html += '<h5>Structured Result:</h5>';
                        html += '<pre style="background:#f8f9fa; padding:10px; border-radius:4px; overflow-x:auto;">' + escapeHtml(JSON.stringify(result.result, null, 2)) + '</pre>';
                    }
                } else if (resultResponse.status !== 409) {
                    // 409 means job not in terminal state (shouldn't happen here), other errors we show
                    html += '<p style="color:orange;">Could not load job result (HTTP ' + resultResponse.status + ')</p>';
                }
            } catch (resultErr) {
                html += '<p style="color:orange;">Network error loading result: ' + resultErr.message + '</p>';
            }
        }

        detailContent.innerHTML = html;
    } catch (err) {
        detailContent.innerHTML = '<p style="color:red;">Network error loading job details: ' + err.message + '</p>';
    }
}

/**
 * Cancel a serverless job by POSTing to /api/jobs/{id}/cancel.
 * Shows a confirmation dialog before proceeding.
 * @param {string} jobId - The UUID of the job to cancel
 */
async function cancelJob(jobId) {
    if (!confirm('Are you sure you want to cancel this job?')) {
        return;
    }

    try {
        const response = await fetch('/api/jobs/' + jobId + '/cancel', {
            method: 'POST',
            credentials: 'same-origin'
        });

        if (response.ok) {
            alert('Job cancelled successfully.');
            refreshJobList();
        } else {
            const errorData = await response.json().catch(() => null);
            const errorMsg = errorData && errorData.error ? errorData.error : 'HTTP ' + response.status;
            if (response.status === 409) {
                alert('Cannot cancel job: ' + errorMsg);
            } else {
                alert('Failed to cancel job: ' + errorMsg);
            }
        }
    } catch (err) {
        alert('Network error cancelling job: ' + err.message);
    }
}

/**
 * Load serverless job metrics from GET /api/jobs/metrics (admin-only)
 * and render the metrics panel with styled metric cards.
 */
async function loadServerlessMetrics() {
    const content = document.getElementById('serverlessMetricsContent');
    if (!content) return;

    try {
        const response = await fetch('/api/jobs/metrics', {
            method: 'GET',
            credentials: 'same-origin'
        });

        if (response.status === 403) {
            content.innerHTML = '<p style="color:#666; font-style:italic;">Metrics are available to administrators only.</p>';
            return;
        }

        if (!response.ok) {
            content.innerHTML = '<p style="color:red;">Failed to load metrics (HTTP ' + response.status + ')</p>';
            return;
        }

        const data = await response.json();

        const avgExec = data.avg_execution_time !== null ? data.avg_execution_time + 's' : 'N/A';
        const avgStartup = data.avg_startup_duration !== null ? data.avg_startup_duration + 's' : 'N/A';

        let html = '<div style="display:flex; flex-wrap:wrap; gap:15px;">';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#6c757d;">' + data.pending_count + '</div>';
        html += '<div style="font-size:12px; color:#888;">Pending</div>';
        html += '</div>';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#007bff;">' + data.running_count + '</div>';
        html += '<div style="font-size:12px; color:#888;">Running</div>';
        html += '</div>';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#dc3545;">' + data.failed_count + '</div>';
        html += '<div style="font-size:12px; color:#888;">Failed</div>';
        html += '</div>';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#28a745;">' + avgExec + '</div>';
        html += '<div style="font-size:12px; color:#888;">Avg Execution</div>';
        html += '</div>';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#6c757d;">' + data.queue_depth + '</div>';
        html += '<div style="font-size:12px; color:#888;">Queue Depth</div>';
        html += '</div>';

        html += '<div style="flex:1; min-width:120px; padding:12px; background:#fff; border-radius:6px; border:1px solid #e0e0e0; text-align:center;">';
        html += '<div style="font-size:24px; font-weight:bold; color:#17a2b8;">' + avgStartup + '</div>';
        html += '<div style="font-size:12px; color:#888;">Avg Startup</div>';
        html += '</div>';

        html += '</div>';

        content.innerHTML = html;
    } catch (err) {
        content.innerHTML = '<p style="color:red;">Network error loading metrics: ' + err.message + '</p>';
    }
}

/**
 * Escape HTML special characters to prevent XSS when displaying user content.
 * @param {string} text - The text to escape
 * @returns {string} The escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}
/* ------------------------------------------------------------------------- *
 * Sortable table headers (Sort_Helper)                                        *
 *                                                                             *
 * Reusable click-to-sort helper attached to dashboard tables. This is a       *
 * UI-only feature: it reorders already-rendered <tbody> rows in place and     *
 * issues no data requests.                                                    *
 *                                                                             *
 * NOTE: The functions below are STUBS added in task 1.1. Real logic is filled *
 * in by later tasks (2.x - 6.x). They are intentionally minimal placeholders. *
 * ------------------------------------------------------------------------- */

/**
 * Attach click-to-sort behavior to a rendered table.
 *
 * @param {HTMLTableElement|null} table - the table produced by a render function.
 *        If null or without a <thead>/<tbody>, the call is a no-op.
 * @param {Object} [options]
 * @param {number[]} [options.excludeColumns] - additional zero-based column indices to
 *        exclude from sorting (beyond the auto-detected trailing Actions column).
 * @param {string[]} [options.actionHeaderLabels] - header texts (case-insensitive) that
 *        mark a non-sortable Actions column. Defaults to ['actions'] plus the localized
 *        "actions" label used by the templates.
 * @returns {void}
 */
function makeSortable(table, options) {
    // Guard/no-op when the table, its <thead>, or its <tbody> rows are absent
    // (Requirement 6.1 error handling; design "No table / empty table").
    if (!table || !table.querySelector) return;
    if (!table.querySelector('thead')) return;
    const tbody = table.querySelector('tbody');
    if (!tbody || !tbody.querySelector('tr')) return;

    // Store options on the element so applySort/updateIndicators resolve headers
    // with the same exclusion rules via table._sortOptions.
    const opts = options || {};
    table._sortOptions = opts;

    // Per-table sort state: null column and 'asc' until the first click. Storing
    // it on the element means re-rendering a panel naturally resets the state.
    table._sortState = { colIndex: null, dir: 'asc' };

    // Resolve per-column metadata (which headers are sortable vs excluded).
    const headers = resolveHeaders(table, opts);

    headers.forEach(function (h) {
        // Excluded headers (trailing Actions column, options.excludeColumns) get
        // no listener, no pointer cursor, and no indicator span (Req 1.4, 4.2).
        if (!h.sortable) return;

        const th = h.th;
        const colIndex = h.index;

        // Wrap the label once in a dedicated <span class="sort-indicator"> so the
        // arrow lives in its own span; the label text is kept intact and the empty
        // indicator span is appended after it (design "Implementation detail").
        if (!th.querySelector('span.sort-indicator')) {
            const span = th.ownerDocument.createElement('span');
            span.className = 'sort-indicator';
            th.appendChild(span);
        }

        // Visual affordance and machine-readable marker for sortable headers.
        th.style.cursor = 'pointer';
        th.setAttribute('data-sortable', 'true');

        // Click sorts by this column (Req 1.1); no sort/indicator at attach time
        // preserves the initial order (Req 4.1, 4.2).
        th.addEventListener('click', function () {
            applySort(table, colIndex);
        });
    });
}

/**
 * Locate the table's <th> cells and decide which are sortable, marking the
 * trailing Actions column and any options.excludeColumns indices as excluded.
 *
 * @param {HTMLTableElement} table
 * @param {Object} [options]
 * @param {number[]} [options.excludeColumns] - additional zero-based indices to exclude.
 * @param {string[]} [options.actionHeaderLabels] - header texts (case-insensitive) that
 *        mark a non-sortable trailing Actions column. Defaults to ['actions'].
 * @returns {Array<{index:number, sortable:boolean, excluded:boolean, th:HTMLTableCellElement}>}
 */
function resolveHeaders(table, options) {
    const opts = options || {};

    // Header texts (lower-cased) that mark a non-sortable trailing Actions column.
    // Defaults to ['actions'] plus any localized label the templates render for
    // get_text('actions'); callers may override/extend via options.actionHeaderLabels.
    const actionLabels = (opts.actionHeaderLabels || ['actions']).map(function (label) {
        return String(label).trim().toLowerCase();
    });

    // Additional zero-based column indices to exclude from sorting.
    const excludeSet = {};
    (opts.excludeColumns || []).forEach(function (idx) {
        excludeSet[idx] = true;
    });

    // Locate the <th> cells. Prefer the header row so stray body <th> cells are ignored.
    let ths = [];
    if (table && table.querySelectorAll) {
        const headRow = table.querySelector('thead tr');
        if (headRow) {
            ths = Array.prototype.slice.call(headRow.querySelectorAll('th'));
        } else {
            ths = Array.prototype.slice.call(table.querySelectorAll('th'));
        }
    }

    // Determine the trailing Actions column: the last <th> whose lower-cased text
    // matches one of the action labels. Only the trailing header qualifies.
    let actionsIndex = -1;
    if (ths.length > 0) {
        const lastIndex = ths.length - 1;
        const lastText = (ths[lastIndex].textContent || '').trim().toLowerCase();
        if (actionLabels.indexOf(lastText) !== -1) {
            actionsIndex = lastIndex;
        }
    }

    return ths.map(function (th, index) {
        const excluded = (index === actionsIndex) || (excludeSet[index] === true);
        return {
            index: index,
            th: th,
            sortable: !excluded,
            excluded: excluded
        };
    });
}

/**
 * Read the displayed (flattened) text of a body cell.
 *
 * @param {HTMLTableRowElement} row
 * @param {number} colIndex
 * @returns {string}
 */
function getCellText(row, colIndex) {
    const cell = row && row.children ? row.children[colIndex] : null;
    if (!cell) return '';
    // textContent flattens nested markup: <span class="status-active">Active</span> -> "Active",
    // <a>...url...</a> -> the url text, <select><option selected>X</option></select> -> "X".
    return (cell.textContent || '').trim();
}

/**
 * Infer the column type from displayed cell text.
 *
 * @param {string[]} values
 * @returns {'numeric'|'date'|'text'}
 */
function detectColumnType(values) {
    // Ignore empty/placeholder values so a few blanks don't force a column to text.
    const meaningful = (values || []).filter(function (v) {
        return v !== '' && v !== '-' && v !== 'N/A';
    });
    if (meaningful.length === 0) return 'text';
    // Check numeric before date so plain numbers (e.g. "2024") aren't misread as dates.
    if (meaningful.every(isNumericText)) return 'numeric';
    if (meaningful.every(isDateText)) return 'date';
    return 'text';
}

/**
 * Return true when the text represents a numeric value.
 *
 * @param {string} v
 * @returns {boolean}
 */
function isNumericText(v) {
    if (typeof v !== 'string') return false;
    // Strip currency/thousands-separators/whitespace, then a trailing duration suffix (m/s/h).
    const stripped = v.replace(/[$,\s]/g, '').replace(/(m|s|h)$/i, '');
    return stripped !== '' && !isNaN(Number(stripped));
}

/**
 * Parse a numeric value from displayed text.
 *
 * @param {string} v
 * @returns {number}
 */
function toNumber(v) {
    return parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
}

/**
 * Return true when the text represents a date value.
 *
 * @param {string} v
 * @returns {boolean}
 */
function isDateText(v) {
    // A purely numeric value (e.g. "2024") stays numeric, not date.
    return !isNumericText(v) && !Number.isNaN(Date.parse(v));
}

/**
 * Parse a date (epoch ms) from displayed text.
 *
 * @param {string} v
 * @returns {number}
 */
function toDate(v) {
    return Date.parse(v);
}

/**
 * Build a type-aware comparator for the given direction.
 *
 * @param {'numeric'|'date'|'text'} type
 * @param {'asc'|'desc'} dir
 * @returns {(a:string, b:string) => number}
 */
function buildComparator(type, dir) {
    const sign = (dir === 'asc') ? 1 : -1;

    // Empty/placeholder keys sort to the end regardless of direction (treated as
    // the largest value) so blanks don't scatter through the ordering.
    function isBlank(v) {
        return v === '' || v === '-' || v === 'N/A';
    }

    return function (a, b) {
        const aBlank = isBlank(a);
        const bBlank = isBlank(b);
        if (aBlank && bBlank) return 0;
        if (aBlank) return 1;   // a sorts after b, ignoring direction
        if (bBlank) return -1;  // b sorts after a, ignoring direction

        switch (type) {
            case 'numeric':
                return sign * (toNumber(a) - toNumber(b));              // Req 2.1
            case 'date':
                return sign * (toDate(a) - toDate(b));                  // Req 2.2
            default:
                return sign * a.localeCompare(b, undefined,            // Req 2.3
                    { numeric: false, sensitivity: 'base' });
        }
    };
}

/**
 * Reorder the table's <tbody> rows by the given column, toggling direction and
 * updating indicators.
 *
 * @param {HTMLTableElement} table
 * @param {number} colIndex
 * @returns {void}
 */
function applySort(table, colIndex) {
    if (!table) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // Read/guard per-table sort state (initialized by makeSortable).
    const state = table._sortState || (table._sortState = { colIndex: null, dir: 'asc' });

    // Same column toggles direction; a new column starts ascending (Req 1.2, 1.3).
    const dir = (colIndex === state.colIndex)
        ? (state.dir === 'asc' ? 'desc' : 'asc')
        : 'asc';

    // Collect the body rows (direct children only).
    const rows = Array.from(tbody.querySelectorAll(':scope > tr'));

    // Read displayed cell text and detect the column type from those values.
    const values = rows.map(function (r) { return getCellText(r, colIndex); });
    const type = detectColumnType(values);
    const cmp = buildComparator(type, dir);

    // Decorate-sort-undecorate: keep the original index as a stable tiebreaker so
    // equal keys retain their relative order and a plain toggle reverses cleanly.
    const decorated = rows.map(function (row, i) {
        return { row: row, key: values[i], index: i };
    });
    decorated.sort(function (a, b) {
        const c = cmp(a.key, b.key);
        if (c !== 0) return c;
        return a.index - b.index;
    });

    // Reorder in place (Req 1.1).
    decorated.forEach(function (d) { tbody.appendChild(d.row); });

    // Persist state and update the indicator.
    state.colIndex = colIndex;
    state.dir = dir;
    updateIndicators(table, colIndex, dir);
}

/**
 * Clear indicators on all sortable headers and render the ▲/▼ indicator on the
 * active header.
 *
 * @param {HTMLTableElement} table
 * @param {number} activeIndex
 * @param {'asc'|'desc'} dir
 * @returns {void}
 */
function updateIndicators(table, activeIndex, dir) {
    if (!table) return;

    // Resolve headers so only sortable columns can carry an indicator; the
    // trailing Actions column (and any excluded columns) never get a glyph.
    const headers = resolveHeaders(table, table._sortOptions);

    // Locate (or lazily create) the dedicated indicator span for a header.
    // makeSortable (task 6.1) wraps each sortable label in a
    // <span class="sort-indicator"> at attach time; when that hasn't happened
    // yet we create/append one on demand so this function is self-sufficient.
    function getIndicatorSpan(th, create) {
        let span = th.querySelector('span.sort-indicator');
        if (!span && create) {
            span = th.ownerDocument.createElement('span');
            span.className = 'sort-indicator';
            th.appendChild(span);
        }
        return span;
    }

    // Clear the glyph on every sortable header's indicator span (Req 3.3).
    headers.forEach(function (h) {
        if (!h.sortable) return;
        const span = getIndicatorSpan(h.th, false);
        if (span) span.textContent = '';
    });

    // Write ▲ (asc) / ▼ (desc) into the active header's indicator span so that
    // exactly one header shows an indicator (Req 3.1, 3.2).
    const active = headers[activeIndex];
    if (active && active.sortable) {
        const span = getIndicatorSpan(active.th, true);
        span.textContent = (dir === 'asc') ? ' ▲' : ' ▼';
    }
}

/* ------------------------------------------------------------------------- *
 * AppCard state -> background color resolver (Running_State highlight)        *
 *                                                                             *
 * Mirrors the state derivation and background-color assignment used by the    *
 * inline status-styling block in templates/dashboard.html (~lines 2661-2691   *
 * for derivation, ~2785-2834 for styling). Extracted here so the state->color *
 * mapping can be exercised by the Node/jsdom test harness without a full DOM. *
 *                                                                             *
 * Color mapping:                                                              *
 *   Running     -> '#d4edda' (Soft_Green)                                     *
 *   NotRunning  -> '#f8d7da' (Soft_Red)                                       *
 *   Other       -> unchanged (resolver returns '' as the "no highlight" value)*
 * ------------------------------------------------------------------------- */

/** Soft_Green background applied to Running_State AppCards. */
const RUNNING_BACKGROUND_COLOR = '#d4edda';
/** Soft_Red background applied to Not_Running_State AppCards. */
const NOT_RUNNING_BACKGROUND_COLOR = '#f8d7da';

/**
 * Resolve an AppCard's status from its raw `logs` text, mirroring the
 * derivation performed inline in templates/dashboard.html.
 *
 * The dashboard first checks for the cloned-but-not-compliant and not-cloned
 * conditions via case-insensitive log substrings, then (when the app is cloned
 * and compliant) parses the JSON emitted after a `STDOUT:` marker to read
 * `docker_compose_ps`, falling back to raw `IS_RUNNING` / `IS_NOT_RUNNING`
 * substring matching when the JSON cannot be parsed.
 *
 * @param {string} logs - Raw status/log text for the application.
 * @returns {('Running'|'NotRunning'|'Other')} The resolved status.
 */
function resolveAppCardStatus(logs) {
    const text = (logs === null || logs === undefined) ? '' : String(logs);
    const lower = text.toLowerCase();

    // Cloned-but-not-compliant and not-cloned are "Other" states: they never
    // receive the running / not-running highlight colors.
    const isClonedButNotCompliant = lower.includes('deployapp.sh not found');
    if (isClonedButNotCompliant) {
        return 'Other';
    }

    const isNotCloned = lower.includes('application not deployed') ||
                        lower.includes('clone it first');
    if (isNotCloned) {
        return 'Other';
    }

    // Cloned and compliant: determine running state. Prefer the JSON
    // `docker_compose_ps` field; fall back to raw substring matching.
    let isRunning = false;
    let isNotRunning = false;
    try {
        const lines = text.split('\n');
        const stdoutIndex = lines.findIndex(function (line) {
            return line.includes('STDOUT:');
        });
        const jsonLines = stdoutIndex >= 0 ? lines.slice(stdoutIndex + 1) : lines;
        const jsonString = jsonLines.join('\n').trim();

        const statusData = JSON.parse(jsonString);
        if (statusData && statusData.docker_compose_ps) {
            isRunning = statusData.docker_compose_ps === 'IS_RUNNING';
            isNotRunning = statusData.docker_compose_ps === 'IS_NOT_RUNNING';
        }
    } catch (e) {
        // Fallback to old text parsing when JSON is absent/malformed.
        isRunning = text.includes('IS_RUNNING');
        isNotRunning = text.includes('IS_NOT_RUNNING');
    }

    if (isRunning) {
        return 'Running';
    }
    if (isNotRunning) {
        return 'NotRunning';
    }
    return 'Other';
}

/**
 * Map a resolved AppCard status to the background color the dashboard applies.
 *
 * @param {('Running'|'NotRunning'|'Other')} status - Resolved status.
 * @returns {string} '#d4edda' for Running, '#f8d7da' for NotRunning, '' otherwise.
 */
function statusToBackgroundColor(status) {
    if (status === 'Running') {
        return RUNNING_BACKGROUND_COLOR;
    }
    if (status === 'NotRunning') {
        return NOT_RUNNING_BACKGROUND_COLOR;
    }
    // Other_State: no running/not-running highlight; leave background unchanged.
    return '';
}

/**
 * Resolve an AppCard's status from raw logs and return the background color to
 * apply. Convenience wrapper combining resolveAppCardStatus and
 * statusToBackgroundColor.
 *
 * @param {string} logs - Raw status/log text for the application.
 * @returns {string} '#d4edda' (Running), '#f8d7da' (NotRunning), or '' (Other).
 */
function resolveAppCardBackgroundColor(logs) {
    return statusToBackgroundColor(resolveAppCardStatus(logs));
}

/*
 * Export the Sort_Helper functions for the Node/jsdom test harness. In the
 * browser `module` is undefined, so this block is skipped and the functions
 * remain plain globals loaded via <script>.
 */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        makeSortable,
        resolveHeaders,
        getCellText,
        detectColumnType,
        isNumericText,
        toNumber,
        isDateText,
        toDate,
        buildComparator,
        applySort,
        updateIndicators,
        // AppCard state -> color resolver (Running_State highlight)
        RUNNING_BACKGROUND_COLOR,
        NOT_RUNNING_BACKGROUND_COLOR,
        resolveAppCardStatus,
        statusToBackgroundColor,
        resolveAppCardBackgroundColor,
    };
}
