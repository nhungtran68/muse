// Protocol adapter. Identity and member access tokens must be provided by a
// trusted server-side resolver, never by JSON-RPC arguments or visitor email.
import {createMrStudioTools} from './core.mjs';

const uuid = {type:'string',format:'uuid'};
const definitions = [
  {name:'prepare_request',description:'Chuẩn bị mã cho một yêu cầu mới. Chưa gửi và chưa tạo video.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'create_request',description:'Gửi một yêu cầu video tự do hoặc tạo ảnh. Chỉ gửi khi người dùng yêu cầu. Nếu không chắc đã gửi thành công, kiểm tra trạng thái bằng jobId và không đổi mã khi thử lại.',inputSchema:{type:'object',properties:{jobId:uuid,requestId:uuid,content:{type:'string',minLength:10,maxLength:4000},mode:{type:'string',enum:['video_free','image']}},required:['jobId','requestId','content','mode'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  {name:'get_status',description:'Xem trạng thái yêu cầu của tài khoản đã liên kết.',inputSchema:{type:'object',properties:{jobId:uuid},required:['jobId'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'list_requests',description:'Xem lịch sử gần đây của tài khoản đã liên kết.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:20}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'get_result',description:'Lấy liên kết tải kết quả của yêu cầu đã hoàn tất và còn hiệu lực.',inputSchema:{type:'object',properties:{jobId:uuid},required:['jobId'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}
];

function objectArgs(value) {return value && typeof value==='object' && !Array.isArray(value);}
async function readBoundedBody(request){
  const length=Number(request.headers.get('content-length'));
  if(Number.isFinite(length)&&length>32768)throw new RangeError('Request too large');
  if(!request.body)return '';
  const reader=request.body.getReader(),decoder=new TextDecoder();let size=0,text='';
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel().catch(()=>{});throw new RangeError('Request too large')}text+=decoder.decode(value,{stream:true})}
  return text+decoder.decode();
}
function validate(name,args) {
  const d=definitions.find(x=>x.name===name); if(!d || !objectArgs(args)) return false;
  const props=d.inputSchema.properties;
  if(Object.keys(args).some(k=>!Object.hasOwn(props,k))||(d.inputSchema.required||[]).some(k=>!Object.hasOwn(args,k)))return false;
  for(const [key,value] of Object.entries(args)){
    const spec=props[key];
    if(spec.type==='string'&&(typeof value!=='string'||(spec.minLength&&value.length<spec.minLength)||(spec.maxLength&&value.length>spec.maxLength)))return false;
    if(spec.type==='integer'&&(!Number.isInteger(value)||value<spec.minimum||value>spec.maximum))return false;
    if(spec.enum&&!spec.enum.includes(value))return false;
  }
  return true;
}

export function createMcpHandler({resolveMember,randomUUID=()=>crypto.randomUUID()}) {
  if(typeof resolveMember!=='function') throw new Error('A trusted member resolver is required');
  return async function handle(request){
    if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:{'cache-control':'no-store'}});
    let data;try{data=JSON.parse(await readBoundedBody(request))}catch(error){if(error instanceof RangeError)return new Response('Request too large',{status:413});return Response.json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}},{status:400})}
    if(!objectArgs(data)||data.jsonrpc!=='2.0'||typeof data.method!=='string')return Response.json({jsonrpc:'2.0',id:data?.id??null,error:{code:-32600,message:'Invalid request'}},{status:400});
    if(!Object.hasOwn(data,'id'))return new Response(null,{status:202,headers:{'cache-control':'no-store'}});
    if(typeof data.id!=='string'&&typeof data.id!=='number'&&data.id!==null)return Response.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}},{status:400});
    const respond=result=>Response.json({jsonrpc:'2.0',id:data.id??null,result},{headers:{'cache-control':'no-store'}});
    const error=(code,message)=>Response.json({jsonrpc:'2.0',id:data.id??null,error:{code,message}},{headers:{'cache-control':'no-store'}});
    if(data.method==='server/discover')return respond({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
    if(data.method==='initialize')return respond({protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'Mr Studio',version:'0.1.0'}});
    if(data.method==='ping')return respond({});
    if(data.method==='tools/list')return respond({tools:definitions});
    if(data.method!=='tools/call')return error(-32601,'Method not found');
    const {name,arguments:args={}}=data.params||{};
    if(!validate(name,args))return error(-32602,'Invalid tool arguments');
    // This resolver must check platform identity and retrieve only the linked
    // member's verified session. The model cannot select the target account.
    let context;try{context=await resolveMember(request)}catch{return respond({isError:true,content:[{type:'text',text:'Không thể xác minh tài khoản. Hãy kết nối lại Mr Studio.'}]})}
    if(!context?.client||!context?.accessToken||!context?.mediaGateway)return respond({isError:true,content:[{type:'text',text:'Cần liên kết tài khoản Mr Studio trước khi sử dụng.'}]});
    try{
      const tools=createMrStudioTools(context);
      const result=name==='prepare_request'?{jobId:randomUUID(),requestId:randomUUID()}:
        name==='create_request'?await tools.create(args):name==='get_status'?await tools.status(args):
        name==='list_requests'?await tools.list(args):await tools.result(args);
      return respond({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:{result}});
    }catch{return respond({isError:true,content:[{type:'text',text:'Không thể hoàn tất. Hãy kiểm tra trạng thái yêu cầu trước khi thử lại.'}]})}
  };
}
