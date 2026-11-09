/**
 * Floating documentation link for development mode
 * Appears in the bottom-right corner
 */

export function initDocsLink() {
  if (import.meta.env.PROD) return;
  
  const link = document.createElement('a');
  link.href = 'http://localhost:4322';
  link.target = '_blank';
  link.textContent = '📚 Docs';
  link.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 10px 16px;
    border-radius: 8px;
    text-decoration: none;
    font-family: system-ui, sans-serif;
    font-weight: 600;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    z-index: 9999;
    transition: transform 0.2s, box-shadow 0.2s;
  `;
  
  link.addEventListener('mouseenter', () => {
    link.style.transform = 'translateY(-2px)';
    link.style.boxShadow = '0 6px 20px rgba(102, 126, 234, 0.5)';
  });
  
  link.addEventListener('mouseleave', () => {
    link.style.transform = 'translateY(0)';
    link.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.4)';
  });
  
  document.body.appendChild(link);
}

// Auto-initialize
document.addEventListener('DOMContentLoaded', initDocsLink);
