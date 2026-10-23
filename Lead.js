// ============================================================
// leads.js - Skyline AI · Lead Results Logic
// UPDATED: Fixed Filtering, Status Labels, Faster Saving & Batch Send
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    
    // ── DOM Elements ──
    const leadsList = document.getElementById('leadsList');
    const selectAllCheckbox = document.getElementById('selectAll');
    const selectCountSpan = document.querySelector('.select-count');
    const saveLeadsBtn = document.querySelector('.action-btn.primary');
    const saveBtnText = document.getElementById('saveBtnText');
    const draftOutreachBtn = document.querySelector('.action-btn.secondary');
    const closeWarningBtn = document.getElementById('closeWarning');
    const warningStrip = document.getElementById('warningStrip');
    
    // Modal Elements
    const modalOverlay = document.getElementById('modalOverlay');
    const detailsModal = document.getElementById('detailsModal');
    const closeModalBtn = document.getElementById('closeModal');
    const modalContent = document.getElementById('modalContent');

    // Filter & Context Menu Elements
    const filterDropdownBtn = document.getElementById('filterDropdownBtn');
    const filterDropdown = document.getElementById('filterDropdown');
    const currentFilterSpan = document.getElementById('currentFilter');
    const contextMenu = document.getElementById('contextMenu');
    const pinLeadBtn = document.getElementById('pinLeadBtn');
    const deleteLeadBtn = document.getElementById('deleteLeadBtn');

    // State
    let allLeadsData = []; // Holds all leads from localStorage
    let savedLeadsEmails = new Set(); // Holds emails of saved leads for fast lookup
    let currentFilter = 'all';
    let longPressTimer;
    let selectedLeadIndex = null;

    const BACKEND = 'https://skylineapp-backend-file.onrender.com';
    const token = localStorage.getItem('token');

    // ── 1. Load Data ──
    async function initData() {
        // Load from LocalStorage (Recent Search)
        try {
            const storedData = localStorage.getItem('skyline_leads_data');
            if (storedData) {
                allLeadsData = JSON.parse(storedData);
            }
        } catch (e) {
            console.error('Failed to parse local lead data:', e);
        }

        // Load Saved Leads from Backend
        if (token) {
            try {
                const res = await fetch(`${BACKEND}/api/leads/saved`, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (res.ok) {
                    const data = await res.json();
                    savedLeadsEmails = new Set(data.data.map(l => l.email));
                }
            } catch (e) {
                console.error('Failed to fetch saved leads:', e);
            }
        }

        renderLeads();
    }

    // ── 2. Render Lead Cards ──
    function renderLeads() {
        if (!leadsList) return;
        leadsList.innerHTML = ''; 

        let displayLeads = [];

        if (currentFilter === 'all') {
            displayLeads = [...allLeadsData];
        } else if (currentFilter === 'saved') {
            displayLeads = allLeadsData.filter(lead => savedLeadsEmails.has(lead.email));
        } else if (currentFilter === 'recent') {
            // Show leads found in last 30 days AND not saved
            displayLeads = allLeadsData.filter(lead => !savedLeadsEmails.has(lead.email));
        }

        if (displayLeads.length === 0) {
            leadsList.innerHTML = '<div style="text-align:center; padding:40px; color:#9697A1;">No leads found for this filter.</div>';
            return;
        }

        const countEl = document.getElementById('resultsCount');
        if (countEl) countEl.textContent = `${displayLeads.length} prospects found`;

        displayLeads.forEach((lead, index) => {
            const originalIndex = allLeadsData.indexOf(lead);
            
            const card = document.createElement('div');
            card.className = 'lead-card';
            card.setAttribute('data-index', originalIndex);
            
            let badgeClass = 'low';
            let badgeText = 'Needs verification';
            if (lead.emailStatus === 'verified') {
                badgeClass = 'high';
                badgeText = 'High confidence';
            } else if (lead.email && lead.email.includes('@')) {
                badgeClass = 'medium';
                badgeText = 'Medium confidence';
            }

            const isSaved = savedLeadsEmails.has(lead.email);
            const statusLabel = isSaved 
                ? `<span class="status-label saved">Saved</span>` 
                : `<span class="status-label recent">Recent</span>`;

            const emailDisplay = lead.email || 'No email found';

            card.innerHTML = `
                <div class="card-left">
                    <label class="checkbox-wrapper">
                        <input type="checkbox" class="lead-checkbox">
                        <span class="custom-checkbox">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        </span>
                    </label>
                    <div class="company-logo">
                        <span style="font-weight:700; font-size:18px; color:white;">${lead.companyName ? lead.companyName.charAt(0).toUpperCase() : '?'}</span>
                    </div>
                </div>
                <div class="card-center">
                    <h3 class="company-name">${lead.companyName || 'Unknown Company'}</h3>
                    <div class="info-row email">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9697A1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        <span>${emailDisplay}</span>
                    </div>
                    <div class="confidence-badge ${badgeClass}">
                        <span class="dot"></span>
                        <span>${badgeText}</span>
                    </div>
                </div>
                <div class="card-right">
                    ${statusLabel}
                    <button class="view-btn">
                        More
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                </div>
            `;

            leadsList.appendChild(card);
        });

        initSelectionLogic();
        initLongPressLogic();
    }

    // ── 3. Details Modal Logic ──
    function openDetailsModal(index) {
        const lead = allLeadsData[index];
        if (!lead || !modalOverlay || !modalContent) return;

        const phone = lead.phoneNumber || 'Not publicly listed';
        const info = lead.companyInformation || 'No additional information available.';
        const email = lead.email || 'No email found';

        modalContent.innerHTML = `
            <h2 style="margin-bottom:16px; color:white; font-size:1.2rem;">${lead.companyName}</h2>
            <div style="margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid #2D2F33;">
                <div style="color:#9697A1; font-size:0.8rem; margin-bottom:4px;">Email Address</div>
                <div style="color:white; font-size:1rem; word-break:break-all;">${email}</div>
                <div style="color:${lead.emailStatus === 'verified' ? '#22C55E' : '#FFAA00'}; font-size:0.75rem; margin-top:4px;">Status: ${lead.emailStatus || 'unknown'}</div>
            </div>
            <div style="margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid #2D2F33;">
                <div style="color:#9697A1; font-size:0.8rem; margin-bottom:4px;">Phone Number</div>
                <div style="color:white; font-size:1rem;">${phone}</div>
            </div>
            <div>
                <div style="color:#9697A1; font-size:0.8rem; margin-bottom:4px;">Company Information</div>
                <div style="color:white; font-size:0.9rem; line-height:1.6;">${info}</div>
            </div>
        `;

        modalOverlay.style.display = 'flex';
    }

    function closeModal() {
        if (modalOverlay) modalOverlay.style.display = 'none';
    }

    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if (modalOverlay) {
        modalOverlay.addEventListener('click', function(e) {
            if (e.target === modalOverlay) closeModal();
        });
    }

    if (leadsList) {
        leadsList.addEventListener('click', function(e) {
            if (e.target.closest('.checkbox-wrapper') || e.target.closest('.view-btn')) return;
            const card = e.target.closest('.lead-card');
            if (card) {
                const index = parseInt(card.getAttribute('data-index'));
                openDetailsModal(index);
            }
        });
    }

    // ── 4. Selection Logic ──
    function initSelectionLogic() {
        const leadCheckboxes = document.querySelectorAll('.lead-checkbox');
        
        function updateSelectionState() {
            const total = leadCheckboxes.length;
            const checked = Array.from(leadCheckboxes).filter(cb => cb.checked).length;
            
            if (selectCountSpan) selectCountSpan.textContent = `${checked} selected`;

            if (selectAllCheckbox) {
                if (checked === 0) {
                    selectAllCheckbox.checked = false;
                    selectAllCheckbox.indeterminate = false;
                } else if (checked === total) {
                    selectAllCheckbox.checked = true;
                    selectAllCheckbox.indeterminate = false;
                } else {
                    selectAllCheckbox.checked = false;
                    selectAllCheckbox.indeterminate = true;
                }
            }

            const hasSelection = checked > 0;
            if (saveLeadsBtn) {
                saveLeadsBtn.disabled = !hasSelection;
                saveLeadsBtn.style.opacity = hasSelection ? '1' : '0.5';
            }
            if (draftOutreachBtn) {
                draftOutreachBtn.disabled = !hasSelection;
                draftOutreachBtn.style.opacity = hasSelection ? '1' : '0.5';
            }
        }

        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', function() {
                const isChecked = this.checked;
                leadCheckboxes.forEach(cb => {
                    cb.checked = isChecked;
                });
                updateSelectionState();
            });
        }

        leadCheckboxes.forEach(cb => {
            cb.addEventListener('change', updateSelectionState);
        });

        updateSelectionState();
    }

    // ── 5. Long Press Logic ──
    function initLongPressLogic() {
        const cards = document.querySelectorAll('.lead-card');
        cards.forEach(card => {
            card.addEventListener('mousedown', startPress);
            card.addEventListener('touchstart', startPress, {passive: true});
            card.addEventListener('mouseup', cancelPress);
            card.addEventListener('mouseleave', cancelPress);
            card.addEventListener('touchend', cancelPress);
        });
    }

    function startPress(e) {
        const card = e.currentTarget;
        selectedLeadIndex = parseInt(card.getAttribute('data-index'));
        longPressTimer = setTimeout(() => {
            showContextMenu(e.clientX || e.touches[0].clientX, e.clientY || e.touches[0].clientY);
        }, 600);
    }

    function cancelPress() {
        clearTimeout(longPressTimer);
    }

    function showContextMenu(x, y) {
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = 'block';
    }

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.context-menu')) {
            contextMenu.style.display = 'none';
        }
    });

    if (pinLeadBtn) {
        pinLeadBtn.addEventListener('click', function() {
            if (selectedLeadIndex !== null) {
                const lead = allLeadsData[selectedLeadIndex];
                allLeadsData.splice(selectedLeadIndex, 1);
                allLeadsData.unshift(lead);
                renderLeads();
                contextMenu.style.display = 'none';
            }
        });
    }

    if (deleteLeadBtn) {
        deleteLeadBtn.addEventListener('click', async function() {
            if (selectedLeadIndex !== null && token) {
                const lead = allLeadsData[selectedLeadIndex];
                allLeadsData.splice(selectedLeadIndex, 1);
                renderLeads();
                contextMenu.style.display = 'none';

                try {
                    await fetch(`${BACKEND}/api/leads/${lead.email}`, {
                        method: 'DELETE',
                        headers: { 
                            'Authorization': 'Bearer ' + token,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ email: lead.email, companyName: lead.companyName })
                    });
                } catch (e) {
                    console.error('Failed to delete from backend:', e);
                }
            }
        });
    }

    // ── 6. Filter Dropdown Logic ──
    if (filterDropdownBtn) {
        filterDropdownBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            filterDropdown.classList.toggle('show');
        });
    }

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.dropdown-wrapper')) {
            filterDropdown.classList.remove('show');
        }
    });

    const dropdownItems = document.querySelectorAll('.dropdown-item');
    dropdownItems.forEach(item => {
        item.addEventListener('click', function() {
            const value = this.getAttribute('data-value');
            currentFilter = value;
            dropdownItems.forEach(i => i.classList.remove('active'));
            this.classList.add('active');
            currentFilterSpan.textContent = this.textContent;
            renderLeads();
            filterDropdown.classList.remove('show');
        });
    });

    // ── 7. Save Leads Backend Integration (Optimized) ──
    if (saveLeadsBtn) {
        saveLeadsBtn.addEventListener('click', async function() {
            if (this.disabled || !token) return;
            
            const selectedCards = document.querySelectorAll('.lead-checkbox:checked');
            if (selectedCards.length === 0) return;

            const leadsToSave = [];
            selectedCards.forEach(cb => {
                const card = cb.closest('.lead-card');
                const index = parseInt(card.getAttribute('data-index'));
                leadsToSave.push(allLeadsData[index]);
            });

            saveBtnText.textContent = 'Saving...';
            saveLeadsBtn.disabled = true;

            // Update UI immediately
            leadsToSave.forEach(l => savedLeadsEmails.add(l.email));
            renderLeads();

            try {
                await fetch(`${BACKEND}/api/leads/save`, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ leads: leadsToSave })
                });
                saveBtnText.textContent = 'Saved';
                setTimeout(() => { saveBtnText.textContent = 'Save leads'; }, 2000);
            } catch (e) {
                console.error('Save error:', e);
                saveBtnText.textContent = 'Error';
            } finally {
                saveLeadsBtn.disabled = false;
            }
        });
    }

    // ── 8. Draft Outreach (Batch Send) ──
    if (draftOutreachBtn) {
        draftOutreachBtn.addEventListener('click', async function() {
            if (this.disabled || !token) return;

            const selectedCards = document.querySelectorAll('.lead-checkbox:checked');
            if (selectedCards.length === 0) return;

            const leadsToSend = [];
            selectedCards.forEach(cb => {
                const card = cb.closest('.lead-card');
                const index = parseInt(card.getAttribute('data-index'));
                const lead = allLeadsData[index];
                
                // Format for backend
                leadsToSend.push({
                    name: lead.companyName,
                    email: lead.email,
                    company: lead.companyName,
                    messages: [{
                        subject: 'Partnership Inquiry',
                        body: `Hi ${lead.companyName},\n\nI came across your company and was impressed by your work. I'd love to discuss a potential partnership.\n\nBest regards,\nSkyline AI User`
                    }]
                });
            });

            const originalText = draftOutreachBtn.innerHTML;
            draftOutreachBtn.innerHTML = '<span>Sending...</span>';
            draftOutreachBtn.disabled = true;

            try {
                const res = await fetch(`${BACKEND}/api/leads/batch-send`, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ leads: leadsToSend })
                });

                if (res.ok) {
                    alert('Outreach sent successfully!');
                    // Uncheck all after sending
                    document.querySelectorAll('.lead-checkbox:checked').forEach(cb => cb.checked = false);
                    initSelectionLogic(); // Reset button states
                } else {
                    alert('Failed to send outreach.');
                }
            } catch (e) {
                console.error('Send error:', e);
                alert('Network error while sending.');
            } finally {
                draftOutreachBtn.innerHTML = originalText;
                draftOutreachBtn.disabled = false;
            }
        });
    }

    // ── 9. Warning Strip Dismissal ──
    if (closeWarningBtn && warningStrip) {
        closeWarningBtn.addEventListener('click', function() {
            warningStrip.style.display = 'none';
        });
    }

    // Initial Load
    initData();
});
