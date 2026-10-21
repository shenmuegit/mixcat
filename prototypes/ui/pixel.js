const pixelPaths={
 cat:'<path d="M1 2h3v1h2v2h4V3h2V2h3v10h-1v2H2v-2H1z"/><path d="M3 7h3v3H3zm7 0h3v3h-3z" fill="#f5f4f6"/><path d="M6 11h4v1H9v1H7v-1H6z" fill="#c8b8db"/>',
 folder:'<path d="M1 3h5v1h2v1h6v1h1v7h-1v1H2v-1H1z"/><path d="M2 5h4v1h7v1h1v5h-1v1H3v-1H2z" fill="#f5f1fa"/><path d="M3 8h9v3H3z" fill="currentColor" opacity=".16"/>',
 note:'<path d="M3 1h7v1h1v1h1v1h1v10h-1v1H3z"/><path d="M4 2h5v4h3v8H4z" fill="#f7f5f9"/><path d="M6 8h4v1H6zm0 3h4v1H6z"/>',
 book:'<path d="M1 3h5v1h1v1h2V4h1V3h5v10h-5v1H6v-1H1z"/><path d="M2 4h3v1h1v1h1v6H6v-1H2zm8 1h1V4h3v7h-4v1H9V6h1z" fill="#f7f5f9"/>',
 network:'<path d="M1 1h5v5H4v5h6v-1h5v5h-5v-3H3V6H1zm1 1v3h3V2zm9 9v3h3v-3z" fill-rule="evenodd"/><path d="M6 3h6v7h-1V4H6z"/>',
 browser:'<path d="M1 2h14v12H1zm1 4v7h12V6z" fill-rule="evenodd"/><path d="M3 3h1v1H3zm2 0h1v1H5z" fill="#f7f5f9"/>',
 search:'<path d="M4 1h5v1h2v2h1v5h-1v2H9v1H4v-1H2V9H1V4h1V2h2zm0 2v1H3v5h1v1h5V9h1V4H9V3zM10 11h2v1h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1z" fill-rule="evenodd"/>',
 layout:'<path d="M1 2h14v12H1zm1 1v10h3V3zm4 0v10h8V3z" fill-rule="evenodd"/>',
 settings:'<path d="M1 3h3V2h3v3H4V4H1zm6 0h8v1H7zM1 7h9V6h3v3h-3V8H1zm12 0h2v1h-2zM1 12h3v-1h3v3H4v-1H1zm6 0h8v1H7z"/>',
 layers:'<path d="M2 2h9v2h2v2h2v8H6v-2H4v-2H2zm1 1v6h7V3zm2 7v1h7V5h-1v5zm2 2v1h7V7h-1v5z" fill-rule="evenodd"/>'
};
function pixelIcon(name,classes=''){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('class','pixel-icon '+classes);svg.setAttribute('aria-hidden','true');svg.innerHTML=pixelPaths[name];return svg;}
document.querySelector('.brand-mark').replaceChildren(pixelIcon('cat'));
const originals=Object.entries(paths).map(([name,path])=>{const probe=document.createElementNS('http://www.w3.org/2000/svg','svg');probe.innerHTML=path;return[name,probe.innerHTML];});
for(const icon of document.querySelectorAll('svg.icon')){const found=originals.find(([,path])=>icon.innerHTML===path);if(found&&pixelPaths[found[0]])icon.replaceWith(pixelIcon(found[0],icon.getAttribute('class').replace('icon','')));}
// The pixel edit keeps the original routing and conversations intact.
document.querySelector('.connections path[stroke-dasharray]').setAttribute('d','M736 292V370H445V304');
document.querySelector('.connections path[stroke-dasharray]').setAttribute('stroke-dasharray','4 5');
document.title='Mixcat · 极简像素工作空间';
