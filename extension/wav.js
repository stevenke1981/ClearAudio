export function header(bytes,rate){
  const b=new ArrayBuffer(56),v=new DataView(b);const str=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
  str(0,'RIFF');v.setUint32(4,bytes+48,true);str(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,3,true);v.setUint16(22,2,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*8,true);v.setUint16(32,8,true);v.setUint16(34,32,true);
  str(36,'fact');v.setUint32(40,4,true);v.setUint32(44,bytes/8,true);str(48,'data');v.setUint32(52,bytes,true);return b;
}
