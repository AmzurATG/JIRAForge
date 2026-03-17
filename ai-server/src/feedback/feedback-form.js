/**
 * Feedback Form - External JavaScript
 * Handles image upload, form submission, and status polling
 */

(function() {
    'use strict';

    // State
    const MAX_IMAGES = 3;
    const MAX_SIZE = 5 * 1024 * 1024;
    let selectedImages = []; // { file, dataUrl, base64, type }
    let feedbackId = null;
    let pollTimer = null;

    // Get session from URL
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');

    // DOM Elements
    let uploadArea, fileInput, previewsContainer, submitBtn, formEl;

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        uploadArea = document.getElementById('upload-area');
        fileInput = document.getElementById('file-input');
        previewsContainer = document.getElementById('image-previews');
        submitBtn = document.getElementById('submit-btn');
        formEl = document.getElementById('feedback-form');

        // Setup event listeners
        setupUploadListeners();
        setupFormListeners();
    }

    // ==================== Image Upload ====================

    function setupUploadListeners() {
        uploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', function() {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });

        fileInput.addEventListener('change', function(e) {
            handleFiles(e.target.files);
            fileInput.value = '';
        });

        // Paste from clipboard (Ctrl+V / Cmd+V)
        document.addEventListener('paste', function(e) {
            var items = e.clipboardData && e.clipboardData.items;
            if (!items) return;

            var imageFiles = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image/') === 0) {
                    var file = items[i].getAsFile();
                    if (file) imageFiles.push(file);
                }
            }

            if (imageFiles.length > 0) {
                e.preventDefault();
                handleFiles(imageFiles);
            }
        });
    }

    function handleFiles(files) {
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (selectedImages.length >= MAX_IMAGES) {
                showFormError('Maximum ' + MAX_IMAGES + ' images allowed');
                break;
            }
            if (file.size > MAX_SIZE) {
                showFormError(file.name + ' exceeds 5MB limit');
                continue;
            }
            if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].indexOf(file.type) === -1) {
                showFormError(file.name + ' is not a supported image type');
                continue;
            }

            (function(f) {
                var reader = new FileReader();
                reader.onload = function(e) {
                    var dataUrl = e.target.result;
                    var base64 = dataUrl.split(',')[1];
                    selectedImages.push({
                        file: f,
                        dataUrl: dataUrl,
                        base64: base64,
                        type: f.type,
                        name: f.name
                    });
                    renderPreviews();
                };
                reader.readAsDataURL(f);
            })(file);
        }
    }

    function renderPreviews() {
        previewsContainer.innerHTML = '';
        selectedImages.forEach(function(img, index) {
            var div = document.createElement('div');
            div.className = 'image-preview';

            var imgEl = document.createElement('img');
            imgEl.src = img.dataUrl;
            imgEl.alt = 'Preview';

            var removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.type = 'button';
            removeBtn.title = 'Remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.setAttribute('data-index', index);
            removeBtn.addEventListener('click', function() {
                removeImage(parseInt(this.getAttribute('data-index'), 10));
            });

            div.appendChild(imgEl);
            div.appendChild(removeBtn);
            previewsContainer.appendChild(div);
        });

        // Hide upload area if max images reached
        if (selectedImages.length >= MAX_IMAGES) {
            uploadArea.style.display = 'none';
        } else {
            uploadArea.style.display = '';
        }
    }

    function removeImage(index) {
        selectedImages.splice(index, 1);
        renderPreviews();
    }

    // ==================== Form Submission ====================

    function setupFormListeners() {
        formEl.addEventListener('submit', function(e) {
            e.preventDefault();
        });

        submitBtn.addEventListener('click', function(e) {
            e.preventDefault();
            submitFeedback();
        });
    }

    function showFormError(msg) {
        var el = document.getElementById('form-error');
        el.textContent = msg;
        el.classList.remove('hidden');
        setTimeout(function() {
            el.classList.add('hidden');
        }, 5000);
    }

    function submitFeedback() {
        var category = document.getElementById('category').value;
        var title = document.getElementById('title').value.trim();
        var priority = document.getElementById('priority').value;
        var description = document.getElementById('description').value.trim();

        if (!category) {
            showFormError('Please select a category');
            return;
        }
        if (!description) {
            showFormError('Please provide a description');
            return;
        }
        if (!sessionId) {
            showFormError('Invalid session. Please reopen from the desktop app.');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        submitBtn.textContent = 'Submitting...';

        var payload = {
            session_id: sessionId,
            category: category,
            title: title || undefined,
            priority: priority || undefined,
            description: description,
            images: selectedImages.map(function(img) {
                return {
                    data: img.base64,
                    name: img.name,
                    type: img.type
                };
            })
        };

        fetch('/api/feedback/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(function(resp) {
            return resp.json().then(function(result) {
                if (!resp.ok || !result.success) {
                    throw new Error(result.error || 'Submission failed');
                }
                return result;
            });
        })
        .then(function(result) {
            // Switch to success view
            feedbackId = result.feedback_id;
            document.getElementById('form-card').classList.add('hidden');
            document.getElementById('success-card').classList.remove('hidden');

            // Start polling for status
            startStatusPolling();
        })
        .catch(function(err) {
            showFormError(err.message);
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
            submitBtn.textContent = 'Submit Feedback';
        });
    }

    // ==================== Status Polling ====================

    var pollCount = 0;
    var MAX_POLLS = 60; // Stop after ~3 minutes (60 * 3s)

    function startStatusPolling() {
        if (!feedbackId) return;
        pollCount = 0;
        pollTimer = setInterval(function() {
            pollCount++;
            if (pollCount >= MAX_POLLS) {
                clearInterval(pollTimer);
                var badge = document.getElementById('status-badge');
                badge.className = 'status-badge processing';
                badge.textContent = 'Still processing...';
                var errorEl = document.getElementById('status-error');
                errorEl.textContent = 'Taking longer than expected. The Jira ticket will still be created. You can close this page.';
                errorEl.classList.remove('hidden');
                return;
            }
            checkStatus();
        }, 3000);
        // Also check immediately
        checkStatus();
    }

    function checkStatus() {
        if (!feedbackId) return;

        fetch('/api/feedback/status/' + feedbackId)
            .then(function(resp) {
                return resp.json();
            })
            .then(function(result) {
                if (!result.success) return;

                var badge = document.getElementById('status-badge');
                badge.className = 'status-badge ' + result.status;

                switch (result.status) {
                    case 'pending':
                        badge.textContent = 'Pending';
                        break;
                    case 'processing':
                        badge.textContent = 'Processing...';
                        break;
                    case 'created':
                        badge.textContent = 'Jira Ticket Created';
                        clearInterval(pollTimer);
                        if (result.jira_issue_key) {
                            var linkContainer = document.getElementById('jira-link-container');
                            var link = document.getElementById('jira-link');
                            link.href = result.jira_issue_url || '#';
                            link.textContent = 'View ' + result.jira_issue_key;
                            linkContainer.classList.remove('hidden');
                        }
                        break;
                    case 'failed':
                        badge.textContent = 'Failed';
                        clearInterval(pollTimer);
                        if (result.error) {
                            var errorEl = document.getElementById('status-error');
                            errorEl.textContent = 'Error: ' + result.error;
                            errorEl.classList.remove('hidden');
                        }
                        break;
                }
            })
            .catch(function() {
                // Silently ignore poll errors
            });
    }
})();
