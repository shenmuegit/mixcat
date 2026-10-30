import { app, BrowserWindow, WebContentsView } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root=process.argv[2], clip=readFileSync(join(root,'clip.mp4'));
for(const name of ['userData','sessionData','logs','crashDumps','temp'] as const){const path=join(root,name);mkdirSync(path,{recursive:true});app.setPath(name,path);}
const delay=(ms:number)=>new Promise(done=>setTimeout(done,ms));
let window:BrowserWindow|undefined, view:WebContentsView|undefined;
const server=createServer((req,res)=>{if(req.url==='/clip.mp4'){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':clip.length});res.end(clip);}else if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Stock child proof</title><input id="target" autofocus><video controls preload="auto" src="/clip.mp4"></video><script>window.keys=[];addEventListener("keydown",e=>keys.push({key:e.key,trusted:e.isTrusted,target:e.target.id}));</script>');}else{res.writeHead(404);res.end();}});
app.whenReady().then(async()=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  window=new BrowserWindow({show:false,width:900,height:700});await window.loadURL('data:text/html,<title>Stock parent</title>');
  view=new WebContentsView();window.contentView.addChildView(view);view.setBounds({x:0,y:0,width:880,height:630});
  await view.webContents.loadURL(`http://127.0.0.1:${(server.address() as any).port}/`);
  window.setAlwaysOnTop(process.platform==='win32');window.show();window.focus();view.webContents.focus();
  const evaluate=(code:string,gesture=false)=>view!.webContents.executeJavaScript(code,gesture);
  for(let i=0;i<80 && await evaluate('document.hidden');i++)await delay(100);
  await evaluate('document.getElementById("target").focus();true');
  const boundary:unknown[]=[];view.webContents.on('before-input-event',(event,input)=>boundary.push({key:input.key,prevented:event.defaultPrevented}));
  view.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});view.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await delay(100);
  let playError:string|undefined;try{await evaluate('(()=>{const v=document.querySelector("video");v.muted=true;return v.play()})()',true);}catch(error){playError=String(error);}
  await delay(400);
  const result={electron:process.versions.electron,parent:{visible:window.isVisible(),minimized:window.isMinimized(),offscreen:window.webContents.isOffscreen(),alwaysOnTop:window.isAlwaysOnTop(),bounds:window.getBounds(),document:await window.webContents.executeJavaScript('document.visibilityState')},child:{visible:view.getVisible(),attached:window.contentView.children.includes(view),bounds:view.getBounds(),offscreen:view.webContents.isOffscreen(),...await evaluate('(()=>{const v=document.querySelector("video");return {document:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.id,keys,video:{ready:v.readyState,width:v.videoWidth,height:v.videoHeight,duration:v.duration,time:v.currentTime,paused:v.paused,error:v.error?.code}}})()')},boundary,playError};
  writeFileSync(join(root,'evidence.json'),JSON.stringify(result,null,2));
  assert.equal(result.child.document,'visible');assert(result.child.keys.length>0);assert(result.child.video.time>0.1);
}).then(()=>{view?.webContents.close();window?.destroy();server.close();app.quit();},error=>{console.error(error);view?.webContents.close();window?.destroy();server.close();app.exit(1);});
