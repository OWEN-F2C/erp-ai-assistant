// components/floating-ball.ts

interface FloatingBall {
  mount: (parent: ShadowRoot) => void;
  unmount: () => void;
  toggle: () => void;
  setVisible: (v: boolean) => void;
}

export function createFloatingBall(onToggle: (open: boolean) => void): FloatingBall {
  let el: HTMLDivElement | null = null;
  let isOpen = false;
  let dragState: { startX: number; startY: number; left: number; top: number } | null = null;
  let docListeners: { move: (e: MouseEvent) => void; up: () => void } | null = null;

  function mount(parent: ShadowRoot): void {
    if (el) return;
    el = document.createElement('div');
    el.id = 'erp-enhancer-ball';
    el.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      box-shadow: 0 2px 12px rgba(0,0,0,0.35);
      cursor: pointer;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      overflow: hidden;
      background: transparent;
    `;

    el.innerHTML = `
      <img src="${chrome.runtime.getURL('floating-ball.png')}"
           style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
           draggable="false">
    `;

    el.addEventListener('click', (e) => {
      // Ignore click if we just finished dragging
      if (dragState) return;
      isOpen = !isOpen;
      onToggle(isOpen);
    });

    el.addEventListener('mousedown', (e: MouseEvent) => {
      dragState = null;
      const rect = el!.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const onMove = (ev: MouseEvent) => {
        if (!el) return; // unmounted during drag
        if (!dragState) {
          const dx = ev.clientX - (rect.left + offsetX);
          const dy = ev.clientY - (rect.top + offsetY);
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            dragState = { startX: ev.clientX, startY: ev.clientY, left: rect.left, top: rect.top };
          } else {
            return;
          }
        }
        const dx = ev.clientX - dragState.startX;
        const dy = ev.clientY - dragState.startY;
        let newLeft = dragState.left + dx;
        let newTop = dragState.top + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - 38, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - 38, newTop));
        el!.style.left = `${newLeft}px`;
        el!.style.top = `${newTop}px`;
        el!.style.right = 'auto';
        el!.style.bottom = 'auto';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        docListeners = null;
        setTimeout(() => { dragState = null; }, 0);
      };

      docListeners = { move: onMove, up: onUp };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    parent.appendChild(el);
  }

  function unmount(): void {
    if (docListeners) {
      document.removeEventListener('mousemove', docListeners.move);
      document.removeEventListener('mouseup', docListeners.up);
      docListeners = null;
    }
    el?.remove();
    el = null;
  }

  function toggle(): void {
    isOpen = !isOpen;
    onToggle(isOpen);
  }

  function setVisible(v: boolean): void {
    if (el) el.style.display = v ? '' : 'none';
  }

  return { mount, unmount, toggle, setVisible };
}
