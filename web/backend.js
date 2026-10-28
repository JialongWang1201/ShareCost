'use strict';

// Shared transport contract: the UI works with either Python or Supabase.
window.ShareCostBackend = (() => {
  const config = window.SHARECOST_CONFIG || {backend:'local'};
  const cloud = config.backend === 'supabase';
  let clientPromise;

  async function client() {
    if (!clientPromise) {
      clientPromise = import(new URL('./vendor/supabase.js',document.baseURI).href).then(({createClient}) =>
        createClient(config.supabaseUrl,config.publishableKey,{
          auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'implicit',storageKey:'sharecost-auth-'+new URL(config.supabaseUrl).hostname}
        })
      );
    }
    return clientPromise;
  }

  function authError(error) {
    const messages = {
      invalid_credentials:'邮箱或密码不正确',
      email_not_confirmed:'请先确认邮箱，再登录',
      user_already_exists:'该邮箱已经注册，请直接登录',
      weak_password:'密码需要 8–128 个字符',
      email_address_invalid:'请输入有效邮箱',
      email_address_not_authorized:'请使用已获授权的邮箱，或在 Supabase 中配置邮件发送',
      over_email_send_rate_limit:'邮件发送次数已达上限，请稍后重试',
      over_request_rate_limit:'尝试过于频繁，请一分钟后再试',
      signup_disabled:'注册暂未开启，请联系账本创建者',
      session_not_found:'请先登录',
      refresh_token_not_found:'请先登录',
      refresh_token_already_used:'请先登录'
    };
    return {status:error.status||400,body:{error:messages[error.code]||error.message||'连接失败，请稍后重试'}};
  }

  async function request(path,data) {
    if (!cloud) {
      const response=await fetch('/api'+path,{
        method:data===undefined?'GET':'POST',
        headers:data===undefined?{}:{'Content-Type':'application/json'},
        body:data===undefined?undefined:JSON.stringify(data)
      });
      return {status:response.status,body:await response.json()};
    }

    const supabase=await client();
    if (path==='/register') {
      if(typeof data.name!=='string'||!data.name.trim()||data.name.trim().length>24)
        return {status:400,body:{error:'昵称不能为空，且最多 24 个字符'}};
      if(typeof data.password!=='string'||data.password.length<8||data.password.length>128)
        return {status:400,body:{error:'密码需要 8–128 个字符'}};
      const {data:result,error}=await supabase.auth.signUp({
        email:data.email.trim(),password:data.password,
        options:{data:{name:data.name.trim()},emailRedirectTo:new URL('./',document.baseURI).href}
      });
      if(error)return authError(error);
      return {status:200,body:{ok:true,confirmation_required:!result.session}};
    }
    if (path==='/login') {
      const {error}=await supabase.auth.signInWithPassword({email:data.email.trim(),password:data.password});
      return error?authError(error):{status:200,body:{ok:true}};
    }
    if (path==='/logout') {
      const {error}=await supabase.auth.signOut({scope:'local'});
      return error?authError(error):{status:200,body:{ok:true}};
    }

    const {data:sessionData,error:sessionError}=await supabase.auth.getSession();
    if(sessionError)return authError(sessionError);
    if(!sessionData.session)return {status:401,body:{error:'请先登录'}};
    if(path==='/me') {
      const {data:result,error}=await supabase.auth.getUser();
      if(error)return authError(error);
      const user=result.user;
      return {status:200,body:{user:{id:user.id,email:user.email,name:user.user_metadata?.name||user.email?.split('@')[0]||'Member'}}};
    }

    const {data:result,error}=await supabase.rpc('sharecost_api',{p_path:path,p_data:data===undefined?null:data});
    if(error) {
      if(error.code==='PGRST202'||error.code==='42883')
        return {status:503,body:{error:'云端账本尚未初始化，请先运行数据库安装脚本'}};
      return {status:error.code==='42501'?403:400,body:{error:error.message||'连接失败，请稍后重试'}};
    }
    if(result?.error)return {status:result.status||400,body:{error:result.error}};
    return {status:200,body:result};
  }

  return Object.freeze({cloud,request});
})();
