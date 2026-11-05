export async function persistJobFailure({persist,stop,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxAttempts=3}){
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{await persist();return true;}
    catch(error){
      lastError=error;
      if(attempt<maxAttempts)await sleep(attempt*1000);
    }
  }
  await stop(lastError);
  return false;
}
