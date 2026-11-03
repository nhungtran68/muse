import json,sys,os,threading
from pathlib import Path
deadline=threading.Timer(540,lambda:os._exit(124))
deadline.daemon=True
deadline.start()
from faster_whisper import WhisperModel
media=sys.argv[1]
model_root=Path(sys.argv[2]) if len(sys.argv)>2 else None
model_name=os.environ.get('MUSE_ASR_MODEL','small')
if model_root:
    candidates=sorted(model_root.glob('models--Systran--faster-whisper-'+model_name+'/snapshots/*'))
    model_path=str(candidates[-1]) if candidates else model_name
else:model_path=model_name
model=WhisperModel(model_path,device='cpu',compute_type='int8',cpu_threads=2)
segments,info=model.transcribe(media,language='vi',beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
result=[]
for s in segments:
    result.append({'start':s.start,'end':s.end,'text':s.text,'words':[{'start':w.start,'end':w.end,'word':w.word,'probability':w.probability} for w in (s.words or [])]})
print(json.dumps({'text':' '.join(s['text'].strip() for s in result),'words':[w for s in result for w in s['words']],'segments':result,'engine':'faster-whisper','model':model_name,'language':'vi'},ensure_ascii=False))
