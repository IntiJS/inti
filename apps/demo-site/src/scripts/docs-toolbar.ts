/**
 * Astro Dev Toolbar Plugin - Documentation Link
 * 
 * This plugin adds a button to the Astro Dev Toolbar that quickly
 * opens the Inti.js documentation while you develop.
 */

export default {
  id: 'inti-docs',
  name: 'Inti Docs',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  
  init(canvas, eventTarget) {
    const button = document.createElement('button');
    button.textContent = 'Open Docs';
    button.style.cssText = `
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: opacity 0.2s;
    `;
    
    button.addEventListener('mouseenter', () => {
      button.style.opacity = '0.9';
    });
    
    button.addEventListener('mouseleave', () => {
      button.style.opacity = '1';
    });
    
    button.addEventListener('click', () => {
      // Open the docs in a new tab
      window.open('http://localhost:4322', '_blank');
    });
    
    canvas.appendChild(button);
    
    // Add info
    const info = document.createElement('div');
    info.innerHTML = `
      <div style="
        padding: 16px;
        color: #fff;
        font-family: system-ui, sans-serif;
      ">
        <h3 style="margin: 0 0 12px 0; font-size: 16px;">📚 Inti.js Documentation</h3>
        <p style="margin: 0 0 12px 0; opacity: 0.8; font-size: 14px;">
          Quick access to the documentation while you develop.
        </p>
        <ul style="margin: 0; padding-left: 20px; font-size: 13px; opacity: 0.9;">
          <li>Core Concepts</li>
          <li>Usage Guides</li>
          <li>API Reference</li>
          <li>Creating Adapters</li>
        </ul>
      </div>
    `;
    canvas.appendChild(info);
  }
};
