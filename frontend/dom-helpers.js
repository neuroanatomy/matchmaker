export function el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

export function setStatus(msg) {
    document.getElementById('status-msg').textContent = msg;
}

export function preItem(label, done) {
    const item = el('div', { className: `pre-check ${done ? 'pre-done' : 'pre-missing'}` });
    item.textContent = (done ? '✓ ' : '✗ ') + label;
    return item;
}
