<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1.0" />
  <title>Skyline AA-1 · Inbox</title>
  
  <!-- Fonts: Inter for UI, JetBrains Mono for Data -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet" />

  <style>
    /* ──────────────────────────────────
       DESIGN TOKENS (MATCHING SYSTEM)
    ────────────────────────────────── */
    :root {
      --bg-deep: #050505;
      --bg-surface: #0a0a0a;
      --bg-glass: rgba(20, 20, 20, 0.6);
      --bg-glass-hover: rgba(30, 30, 30, 0.7);
      
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-active: rgba(255, 255, 255, 0.15);
      
      --accent-primary: #ffffff;
      --accent-secondary: #a1a1aa;
      --status-unread: #3b82f6;
      --status-success: #10b981;
      
      --font-ui: 'Inter', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;

      --radius-sm: 6px;
      --radius-md: 12px;
      --radius-lg: 20px;
      
      --header-height: 50px;
      --nav-height: 60px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }

    body {
      background-color: var(--bg-deep);
      color: var(--accent-primary);
      font-family: var(--font-ui);
      font-size: 14px;
      height: 100vh;
      height: 100dvh;      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Ambient Background Glow */
    body::before {
      content: '';
      position: absolute;
      top: -20%; left: -10%;
      width: 60vw; height: 60vw;
      background: radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    /* ──────────────────────────────────
       HEADER (UNIFIED)
    ────────────────────────────────── */
    .app-header {
      height: var(--header-height);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(5, 5, 5, 0.8);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 20;
      flex-shrink: 0;
    }

    .brand-group { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      font-weight: 600;
      font-size: 16px;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-logo svg { width: 18px; height: 18px; color: var(--accent-primary); }

    /* Tab Group Styling */
    .tab-group {
      display: flex;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-full);      padding: 2px;
    }
    .tab-pill {
      padding: 4px 12px;
      border-radius: var(--radius-full);
      border: none;
      background: transparent;
      color: var(--accent-secondary);
      font-family: var(--font-mono);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-pill.active {
      background: var(--bg-glass-hover);
      color: var(--accent-primary);
      border: 1px solid var(--border-subtle);
    }

    /* ──────────────────────────────────
       MAIN CONTAINER & VIEWS
    ────────────────────────────────── */
    .main-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .view-list, .view-chat {
      position: absolute;
      inset: 0;
      background: var(--bg-deep);
      display: flex;
      flex-direction: column;
      transition: transform 0.35s cubic-bezier(0.4,0,0.2,1);
    }
    .view-list.hidden { transform: translateX(-100%); pointer-events: none; }
    .view-chat { transform: translateX(100%); z-index: 30; }
    .view-chat.active { transform: translateX(0); }

    /* Search & Stats */
    .search-shell {
      padding: 16px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .search-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);      padding: 10px 14px;
      color: var(--accent-primary);
      font-family: var(--font-ui);
      outline: none;
    }
    .search-input:focus { border-color: var(--border-active); }

    .stats-row {
      display: flex;
      padding: 12px 16px;
      gap: 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .stat-chip {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px;
      text-align: center;
    }
    .stat-val { font-family: var(--font-mono); font-size: 14px; font-weight: 600; }
    .stat-label { font-family: var(--font-mono); font-size: 9px; color: var(--accent-secondary); text-transform: uppercase; margin-top: 2px; }

    /* Contact List */
    .contact-list {
      flex: 1;
      overflow-y: auto;
    }
    .contact-item {
      padding: 16px;
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
      display: flex;
      gap: 12px;
      transition: background 0.2s;
    }
    .contact-item:hover { background: var(--bg-glass-hover); }
    .contact-item.unread { background: rgba(59, 130, 246, 0.03); }
    
    .avatar {
      width: 40px; height: 40px;
      border-radius: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 14px;
    }
    .contact-info { flex: 1; min-width: 0; }
    .contact-name { font-weight: 500; font-size: 14px; margin-bottom: 2px; }    .contact-preview { 
      color: var(--accent-secondary); 
      font-size: 13px; 
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
    }
    .contact-meta {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--accent-secondary);
      margin-top: 4px;
      display: flex; gap: 8px;
    }

    /* Chat View */
    .chat-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .back-btn {
      background: none; border: none; color: var(--accent-secondary); cursor: pointer;
    }
    
    .messages-container {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg-bubble {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 14px;
      line-height: 1.5;
    }
    .msg-bubble.lead {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      align-self: flex-start;
      border-bottom-left-radius: 2px;
    }
    .msg-bubble.ai {
      background: var(--bg-glass-hover);
      border: 1px solid var(--border-active);      align-self: flex-end;
      border-bottom-right-radius: 2px;
    }

    .reply-area {
      padding: 16px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      display: flex;
      gap: 8px;
    }
    .reply-input {
      flex: 1;
      background: var(--bg-deep);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px;
      color: var(--accent-primary);
      resize: none;
      outline: none;
      height: 40px;
    }
    .send-btn {
      width: 40px; height: 40px;
      background: var(--accent-primary);
      border: none;
      border-radius: var(--radius-md);
      color: var(--bg-deep);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }

    /* Bottom Nav */
    .bottom-nav {
      height: var(--nav-height);
      background: var(--bg-deep);
      border-top: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-around;
      align-items: center;
      flex-shrink: 0;
      z-index: 20;
    }
    .nav-item {
      flex: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;      gap: 4px;
      color: var(--accent-secondary);
      text-decoration: none;
      transition: color 0.2s;
      position: relative;
    }
    .nav-item.active { color: var(--accent-primary); }
    .nav-item.active::before {
      content: '';
      position: absolute;
      top: 0; left: 50%; transform: translateX(-50%);
      width: 40px; height: 2px;
      background: var(--accent-primary);
      box-shadow: 0 0 10px var(--accent-primary);
    }
    .nav-item svg { width: 20px; height: 20px; }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="app-header">
    <div class="brand-group">
      <div class="brand-logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        Skyline
      </div>
    </div>
    <div class="tab-group">
      <button class="tab-pill active" id="tabLeads" onclick="switchTab('leads')">Leads</button>
      <button class="tab-pill" id="tabTeam" onclick="switchTab('team')">Team</button>
    </div>
  </header>

  <div class="main-container">
    
    <!-- VIEW: LIST -->
    <div id="viewList" class="view-list">
      <div class="search-shell">
        <input type="text" class="search-input" placeholder="Search conversations..." oninput="filterContacts(this.value)">
      </div>
      
      <div class="stats-row">
        <div class="stat-chip">
          <div class="stat-val" id="statTotal">0</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat-chip">
          <div class="stat-val" style="color: var(--status-unread)" id="statUnread">0</div>
          <div class="stat-label">Unread</div>        </div>
      </div>

      <div class="contact-list" id="contactList">
        <!-- Contacts injected here -->
      </div>
    </div>

    <!-- VIEW: CHAT -->
    <div id="viewChat" class="view-chat">
      <div class="chat-header">
        <button class="back-btn" onclick="closeChat()">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div>
          <div class="contact-name" id="chatName">Select a Lead</div>
          <div class="contact-meta" id="chatEmail">...</div>
        </div>
      </div>

      <div class="messages-container" id="messagesContainer">
        <div style="text-align:center; color:var(--accent-secondary); margin-top:40px;">
          Select a conversation to begin.
        </div>
      </div>

      <div class="reply-area">
        <textarea class="reply-input" id="replyText" placeholder="Type a reply..."></textarea>
        <button class="send-btn" onclick="sendReply()">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>

  </div>

  <!-- Bottom Navigation -->
  <nav class="bottom-nav">
    <a href="page.html" class="nav-item">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    </a>
    <a href="history.html" class="nav-item">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    </a>
    <a href="notifications.html" class="nav-item active">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </a>
    <a href="dashboard.html" class="nav-item">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
    </a>  </nav>

  <script>
    const BACKEND = 'https://skylineapp-backend-file.onrender.com';
    const token = localStorage.getItem('token');
    if (!token) window.location.href = 'login.html';

    let allContacts = [];
    let currentLeadId = null;
    let currentLeadName = "";
    let currentLeadEmail = "";

    document.addEventListener('DOMContentLoaded', loadContacts);

    async function loadContacts() {
      try {
        const res = await fetch(`${BACKEND}/api/conversations`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        allContacts = await res.json();
        updateStats();
        renderContacts(allContacts);
      } catch (err) { console.error(err); }
    }

    function updateStats() {
      document.getElementById('statTotal').textContent = allContacts.length;
      const unread = allContacts.filter(c => c.unreadCount > 0).length;
      document.getElementById('statUnread').textContent = unread;
    }

    function renderContacts(contacts) {
      const list = document.getElementById('contactList');
      list.innerHTML = '';
      contacts.forEach(c => {
        const item = document.createElement('div');
        item.className = `contact-item ${c.unreadCount > 0 ? 'unread' : ''}`;
        item.onclick = () => openChat(c.id, c.name, c.email);
        item.innerHTML = `
          <div class="avatar">${c.name.charAt(0)}</div>
          <div class="contact-info">
            <div class="contact-name">${c.name}</div>
            <div class="contact-preview">${c.lastMessage || 'No messages yet'}</div>
            <div class="contact-meta">
              <span>${c.company || 'Unknown'}</span>
              <span>•</span>
              <span>${new Date(c.lastDate).toLocaleDateString()}</span>
            </div>
          </div>
        `;        list.appendChild(item);
      });
    }

    function filterContacts(query) {
      const q = query.toLowerCase();
      const filtered = allContacts.filter(c => 
        c.name.toLowerCase().includes(q) || 
        (c.company && c.company.toLowerCase().includes(q))
      );
      renderContacts(filtered);
    }

    function switchTab(tab) {
      document.querySelectorAll('.tab-pill').forEach(t => t.classList.remove('active'));
      document.getElementById(tab === 'leads' ? 'tabLeads' : 'tabTeam').classList.add('active');
      // Logic for team view would go here
    }

    async function openChat(id, name, email) {
      currentLeadId = id;
      currentLeadName = name;
      currentLeadEmail = email;
      
      document.getElementById('chatName').textContent = name;
      document.getElementById('chatEmail').textContent = email;
      document.getElementById('viewChat').classList.add('active');

      // Load messages logic here...
      const container = document.getElementById('messagesContainer');
      container.innerHTML = '<div style="text-align:center; color:var(--accent-secondary);">Loading messages...</div>';
    }

    function closeChat() {
      document.getElementById('viewChat').classList.remove('active');
      currentLeadId = null;
    }

    async function sendReply() {
      const text = document.getElementById('replyText').value.trim();
      if (!text || !currentLeadId) return;
      // Send logic here...
      alert("Reply sent (Simulation)");
      document.getElementById('replyText').value = '';
    }
  </script>
</body>
</html>
