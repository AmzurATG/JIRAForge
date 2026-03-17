import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@forge/bridge';

const CATEGORIES = [
  { value: '', label: 'Select a category...' },
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature_request', label: 'Feature Request' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' }
];

const PRIORITIES = [
  { value: '', label: 'Let AI decide...' },
  { value: 'Highest', label: 'Highest' },
  { value: 'High', label: 'High' },
  { value: 'Medium', label: 'Medium' },
  { value: 'Low', label: 'Low' },
  { value: 'Lowest', label: 'Lowest' }
];

const MAX_IMAGES = 3;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TITLE_LENGTH = 200;
const MAX_POLL_ATTEMPTS = 60; // 3 minutes (60 * 3s)
const POLL_INTERVAL = 3000; // 3 seconds

function FeedbackModal({ isOpen, onClose }) {
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState([]); // { name, type, base64, preview }
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [feedbackId, setFeedbackId] = useState(null);
  const [jiraStatus, setJiraStatus] = useState('pending'); // pending, processing, created, failed
  const [jiraIssueKey, setJiraIssueKey] = useState(null);
  const [jiraIssueUrl, setJiraIssueUrl] = useState(null);
  const [jiraError, setJiraError] = useState(null);
  const fileInputRef = useRef(null);
  const pollCountRef = useRef(0);
  const pollTimerRef = useRef(null);

  // Cleanup polling on unmount or when modal closes
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  // Start polling when feedback is successfully submitted
  useEffect(() => {
    if (feedbackId && success) {
      // eslint-disable-next-line no-use-before-define
      startStatusPolling();
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
    // startStatusPolling is intentionally omitted — it's a stable function that depends on
    // feedbackId (already in deps). Including it would cause infinite re-renders since it's
    // not wrapped in useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackId, success]);

  const resetForm = () => {
    setCategory('');
    setTitle('');
    setPriority('');
    setDescription('');
    setImages([]);
    setError('');
    setSuccess(false);
    setSubmitting(false);
    setFeedbackId(null);
    setJiraStatus('pending');
    setJiraIssueKey(null);
    setJiraIssueUrl(null);
    setJiraError(null);
    pollCountRef.current = 0;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const startStatusPolling = () => {
    if (!feedbackId) return;
    
    pollCountRef.current = 0;
    
    // Clear any existing timer
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    // Poll immediately, then every 3 seconds
    checkStatus();
    pollTimerRef.current = setInterval(() => {
      pollCountRef.current += 1;
      
      if (pollCountRef.current >= MAX_POLL_ATTEMPTS) {
        clearInterval(pollTimerRef.current);
        setJiraStatus('processing');
        setJiraError('Taking longer than expected. The Jira ticket will still be created.');
        return;
      }
      
      checkStatus();
    }, POLL_INTERVAL);
  };

  const checkStatus = async () => {
    if (!feedbackId) return;

    try {
      const result = await invoke('getFeedbackStatus', { feedbackId });
      
      if (result.success) {
        setJiraStatus(result.status);
        
        if (result.status === 'created') {
          setJiraIssueKey(result.jira_issue_key);
          setJiraIssueUrl(result.jira_issue_url);
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
          }
        } else if (result.status === 'failed') {
          setJiraError(result.error || 'Failed to create Jira ticket');
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
          }
        }
      }
    } catch (err) {
      console.error('Error checking feedback status:', err);
      // Silently ignore poll errors
    }
  };

  // Handle paste from clipboard (Ctrl+V / Cmd+V)
  useEffect(() => {
    if (!isOpen || success) return;

    const handlePaste = (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImageFiles(imageFiles);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, success, images.length]);

  const handleImageFiles = (files) => {
    setError('');

    const remaining = MAX_IMAGES - images.length;
    if (files.length > remaining) {
      setError(`You can add ${remaining} more screenshot${remaining !== 1 ? 's' : ''} (max ${MAX_IMAGES})`);
      return;
    }

    files.forEach((file) => {
      if (!file.type.startsWith('image/')) {
        setError('Only image files are allowed');
        return;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        setError(`${file.name} exceeds 5MB limit`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (evt) => {
        const base64 = evt.target.result.split(',')[1];
        setImages((prev) => {
          if (prev.length >= MAX_IMAGES) return prev;
          return [...prev, { name: file.name, type: file.type, base64, preview: evt.target.result }];
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const handleImageAdd = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    handleImageFiles(files);

    // Reset file input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    setError('');

    if (!category) {
      setError('Please select a category');
      return;
    }
    if (!description.trim()) {
      setError('Please enter a description');
      return;
    }

    setSubmitting(true);
    try {
      const result = await invoke('submitFeedback', {
        category,
        title: title.trim(),
        priority,
        description: description.trim(),
        images: images.map((img) => ({ data: img.base64, name: img.name, type: img.type }))
      });

      if (result.success) {
        setFeedbackId(result.feedbackId || result.feedback_id);
        setSuccess(true);
        // Polling will start automatically via useEffect
      } else {
        setError(result.error || 'Failed to submit feedback. Please try again.');
      }
    } catch (err) {
      console.error('Error submitting feedback:', err);
      setError('Failed to submit feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  if (success) {
    const getStatusBadge = () => {
      const badges = {
        pending: { label: 'Pending', className: 'status-pending' },
        processing: { label: 'Processing...', className: 'status-processing' },
        created: { label: 'Jira Ticket Created', className: 'status-created' },
        failed: { label: 'Failed', className: 'status-failed' }
      };
      const badge = badges[jiraStatus] || badges.pending;
      return (
        <span className={`feedback-status-badge ${badge.className}`}>
          {badge.label}
        </span>
      );
    };

    return (
      <div className="modal-overlay" onClick={handleClose}>
        <div className="modal-content feedback-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Feedback Submitted</h3>
            <button className="modal-close" onClick={handleClose}>&times;</button>
          </div>
          <div className="modal-body">
            <div className="feedback-success">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
              <h3>Thank you!</h3>
              <p>Your feedback has been received. A Jira ticket is being created...</p>
              
              <div style={{ marginTop: '20px' }}>
                {getStatusBadge()}
              </div>

              {jiraStatus === 'created' && jiraIssueKey && (
                <div style={{ marginTop: '16px' }}>
                  <a 
                    href={jiraIssueUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="feedback-btn feedback-btn-link"
                  >
                    View {jiraIssueKey}
                  </a>
                </div>
              )}

              {jiraError && (
                <div className="feedback-error" style={{ marginTop: '16px' }}>
                  {jiraError}
                </div>
              )}

              <button
                className="feedback-btn feedback-btn-cancel"
                onClick={handleClose}
                style={{ marginTop: '20px' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Send Feedback</h3>
          <button className="modal-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="feedback-error">{error}</div>}

          <div className="feedback-field">
            <label className="feedback-label">
              Category <span className="feedback-required">*</span>
            </label>
            <select
              className="feedback-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={submitting}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value} disabled={cat.value === ''}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          <div className="feedback-field">
            <label className="feedback-label">Title</label>
            <input
              type="text"
              className="feedback-input"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE_LENGTH))}
              placeholder="Brief summary (optional)"
              disabled={submitting}
              maxLength={MAX_TITLE_LENGTH}
              spellCheck="true"
            />
          </div>

          <div className="feedback-field">
            <label className="feedback-label">
              Priority <span style={{ color: '#999', fontWeight: 400, fontSize: '0.9em' }}>(optional - AI will suggest if not set)</span>
            </label>
            <select
              className="feedback-select"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={submitting}
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="feedback-field">
            <label className="feedback-label">
              Description <span className="feedback-required">*</span>
            </label>
            <textarea
              className="feedback-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your feedback in detail..."
              rows={5}
              disabled={submitting}
              spellCheck="true"
            />
          </div>

          <div className="feedback-field">
            <label className="feedback-label">
              Screenshots {images.length > 0 && `(${images.length}/${MAX_IMAGES})`}
            </label>
            {images.length > 0 && (
              <div className="feedback-screenshots">
                {images.map((img, i) => (
                  <div key={i} className="feedback-screenshot-thumb">
                    <img src={img.preview} alt={img.name} />
                    <button
                      className="feedback-screenshot-remove"
                      onClick={() => removeImage(i)}
                      disabled={submitting}
                      title="Remove"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length < MAX_IMAGES && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImageAdd}
                  style={{ display: 'none' }}
                  id="feedback-file-input"
                />
                <button
                  className="feedback-add-image-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                  type="button"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
                  Add Screenshot
                </button>
              </>
            )}
            <span className="feedback-hint">Max {MAX_IMAGES} images, 5MB each. You can also paste (Ctrl+V)</span>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="feedback-btn feedback-btn-cancel"
            onClick={handleClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="feedback-btn feedback-btn-submit"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FeedbackModal;
