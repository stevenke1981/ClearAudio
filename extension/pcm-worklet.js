class PCM extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(8192);this.used=0;this.active=true;
    this.port.onmessage=e=>{if(e.data==='stop'){this.flush();this.active=false;this.port.postMessage({done:true});}};}
  flush(){if(this.used){const b=this.buffer.slice(0,this.used);this.port.postMessage({pcm:b.buffer},[b.buffer]);this.used=0;}}
  process(inputs){if(!this.active)return false;const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){this.buffer[this.used++]=channels[0][i];this.buffer[this.used++]=(channels[1]||channels[0])[i];if(this.used===this.buffer.length)this.flush();}return true;}
}
registerProcessor('pcm',PCM);
