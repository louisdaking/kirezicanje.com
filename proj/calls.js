const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

export function initCalls({ supabase, me, getProfile, sendInvite, showmessage }) {
  const $ = (id) => document.getElementById(id)
  let inbox = null
  let inboxReady = Promise.resolve()
  let current = null
  let invitationTimer = null

  function setStatus(text) {
    const el = $('callStatus')
    if (el) el.textContent = text
  }

  function showCall(profile, incoming, mode) {
    $('callPeerName').textContent = profile.full_name || 'KIREZI CANJE user'
    $('callPeerAvatar').style.backgroundImage = `url("${profile.profile_pic || ''}")`
    $('callIncoming').hidden = !incoming
    $('callControls').hidden = incoming
    $('callCamera').hidden = mode !== 'video'
    $('callOverlay').classList.add('open')
    setStatus(incoming ? 'Incoming call' : 'Calling…')
  }

  function closeCall() {
    $('callOverlay').classList.remove('open')
    $('callIncoming').hidden = true
    $('callControls').hidden = false
    $('callLocalVideo').srcObject = null
    $('callRemoteVideo').srcObject = null
    $('callRemoteAudio').srcObject = null
    $('callVideos').classList.remove('audio-only')
    $('callMute').textContent = 'Mic on'
    $('callMute').classList.remove('off')
    $('callCamera').textContent = 'Camera on'
    $('callCamera').classList.remove('off')
  }

  async function subscribe(channel) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Realtime connection timed out.')), 10000)
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout)
          reject(new Error('Could not connect to the call service.'))
        }
      })
    })
  }

  function roomTopic(call) {
    return `kc-call-room:${call.id}:${call.caller}:${call.callee}`
  }

  async function openRoom(call) {
    const channel = supabase.channel(roomTopic(call), { config: { private: true, broadcast: { self: false } } })
    await subscribe(channel)
    call.room = channel
    return channel
  }

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach(track => track.stop())
  }

  function cleanup() {
    clearTimeout(invitationTimer)
    invitationTimer = null
    if (!current) return
    const call = current
    current = null
    if (call.pc) call.pc.close()
    stopTracks(call.local)
    if (call.room) supabase.removeChannel(call.room)
    closeCall()
  }

  async function endCall(notify = true) {
    const call = current
    if (call && notify) {
      const target = call.caller === me ? call.callee : call.caller
      if (call.room) {
        try { await call.room.send({ type: 'broadcast', event: 'end', payload: { callId: call.id } }) } catch (e) { console.error('[kirezi] call hangup signal failed', e) }
      } else {
        try { await publish(`kc-call-inbox:${target}`, 'end', { callId: call.id, caller: me }) } catch (e) { console.error('[kirezi] call cancel signal failed', e) }
      }
    }
    cleanup()
  }

  async function addLocalMedia(call, mode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Calls need a supported browser and microphone.')
    }
    call.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' })
    call.local.getTracks().forEach(track => call.pc.addTrack(track, call.local))
    if (mode === 'video') $('callLocalVideo').srcObject = call.local
    $('callVideos').classList.toggle('audio-only', mode !== 'video')
  }

  function setupPeer(call) {
    call.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    call.remoteCandidates = []
    call.remote = new MediaStream()
    $('callRemoteVideo').srcObject = call.remote
    $('callRemoteAudio').srcObject = call.remote
    call.pc.ontrack = (event) => {
      const streams = event.streams || []
      const stream = streams[0]
      if (stream) stream.getTracks().forEach(track => {
        if (!call.remote.getTracks().some(existing => existing.id === track.id)) call.remote.addTrack(track)
      })
      else if (!call.remote.getTracks().some(existing => existing.id === event.track.id)) call.remote.addTrack(event.track)
      setStatus('Connected')
      $('callRemoteAudio').play().catch(() => setStatus('Tap the call screen to enable audio'))
    }
    call.pc.onicecandidate = (event) => {
      if (event.candidate && call.room) {
        const signal = { candidate: event.candidate.toJSON(), callId: call.id }
        if (call.role === 'caller' && !call.roomReady) {
          call.pendingLocalCandidates.push(signal)
          return
        }
        call.room.send({ type: 'broadcast', event: 'ice', payload: signal })
          .then(status => { if (status !== 'ok') console.error('[kirezi] call ICE signal was not delivered') })
          .catch(error => console.error('[kirezi] call ICE signal failed', error))
      }
    }
    call.pc.onconnectionstatechange = () => {
      if (!current || current !== call) return
      if (call.pc.connectionState === 'connected') setStatus('Connected')
      if (call.pc.connectionState === 'failed' || call.pc.connectionState === 'disconnected') {
        setStatus('Connection interrupted. Hang up and try again.')
      }
    }
    call.room
      .on('broadcast', { event: 'ready' }, async ({ payload }) => {
        if (!current || payload.callId !== call.id || call.role !== 'caller') return
        call.roomReady = true
        try {
          const result = await call.room.send({
            type: 'broadcast',
            event: 'offer',
            payload: { callId: call.id, offer: call.offer }
          })
          if (result !== 'ok') throw new Error('Call offer was not delivered')
        } catch (error) {
          console.error('[kirezi] call offer signal failed', error)
          setStatus('Could not connect. Please try again.')
          return
        }
        for (const candidate of call.pendingLocalCandidates.splice(0)) {
          try {
            const result = await call.room.send({ type: 'broadcast', event: 'ice', payload: candidate })
            if (result !== 'ok') console.error('[kirezi] queued call ICE signal was not delivered')
          } catch (error) { console.error('[kirezi] queued call ICE signal failed', error) }
        }
      })
      .on('broadcast', { event: 'offer' }, async ({ payload }) => {
        if (!current || payload.callId !== call.id || call.role !== 'callee') return
        try {
          await call.pc.setRemoteDescription(payload.offer)
          for (const candidate of call.remoteCandidates.splice(0)) await call.pc.addIceCandidate(candidate)
          const answer = await call.pc.createAnswer()
          await call.pc.setLocalDescription(answer)
          const result = await call.room.send({
            type: 'broadcast',
            event: 'answer',
            payload: { callId: call.id, answer: call.pc.localDescription }
          })
          if (result !== 'ok') throw new Error('Call answer was not delivered')
          setStatus('Connecting…')
        } catch (error) {
          console.error('[kirezi] could not answer call offer', error)
          setStatus('Could not connect. Please try again.')
          await endCall()
        }
      })
      .on('broadcast', { event: 'answer' }, async ({ payload }) => {
        if (!current || payload.callId !== call.id || call.role !== 'caller') return
        try {
          await call.pc.setRemoteDescription(payload.answer)
          for (const candidate of call.remoteCandidates.splice(0)) await call.pc.addIceCandidate(candidate)
          setStatus('Connecting…')
        } catch (error) {
          console.error('[kirezi] call answer failed', error)
          setStatus('Could not connect. Please try again.')
        }
      })
      .on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (!current || payload.callId !== call.id || !payload.candidate) return
        try {
          const candidate = new RTCIceCandidate(payload.candidate)
          if (call.pc.remoteDescription) await call.pc.addIceCandidate(candidate)
          else call.remoteCandidates.push(candidate)
        } catch (error) { console.error('[kirezi] invalid call ICE candidate', error) }
      })
      .on('broadcast', { event: 'end' }, ({ payload }) => {
        if (current && payload.callId === call.id) {
          setStatus('Call ended')
          cleanup()
        }
      })
      .on('broadcast', { event: 'decline' }, ({ payload }) => {
        if (current && payload.callId === call.id && call.role === 'caller') {
          showmessage('Call declined.')
          cleanup()
        }
      })
    return call
  }

  async function startCall(userId, mode) {
    if (current) { showmessage('Finish the current call first.'); return }
    if (!userId || userId === me) return
    let profile = {}
    try { profile = await getProfile(userId) || {} }
    catch (error) { console.error('[kirezi] call profile lookup failed', error); showmessage('Could not load this profile.'); return }
    const call = {
      id: crypto.randomUUID(),
      caller: me,
      callee: userId,
      role: 'caller',
      mode,
      room: null,
      pc: null,
      local: null,
      remoteCandidates: [],
      pendingLocalCandidates: [],
      roomReady: false
    }
    current = call
    showCall(profile || {}, false, mode)
    try {
      await addLocalMedia(call, mode)
      if (current !== call) return
      await openRoom(call)
      if (current !== call) return
      setupPeer(call)
      const offer = await call.pc.createOffer()
      await call.pc.setLocalDescription(offer)
      call.offer = call.pc.localDescription
      await inboxReady
      if (current !== call) return
      await sendInvite({ recipient_id: userId, call_id: call.id, mode })
      setStatus('Calling…')
      invitationTimer = setTimeout(() => {
        if (current === call && call.role === 'caller') {
          showmessage('No answer. Try again later.')
          void endCall(false)
        }
      }, 45000)
    } catch (error) {
      console.error('[kirezi] could not start call', error)
      showmessage(error.message || 'Could not start the call.')
      await endCall(false)
    }
  }

  async function answerCall() {
    const call = current
    if (!call || call.role !== 'callee') return
    clearTimeout(invitationTimer)
    $('callIncoming').hidden = true
    $('callControls').hidden = false
    setStatus('Connecting…')
    try {
      await addLocalMedia(call, call.mode)
      if (current !== call) return
      const result = await call.room.send({
        type: 'broadcast',
        event: 'ready',
        payload: { callId: call.id }
      })
      if (result !== 'ok') throw new Error('The caller could not be reached.')
    } catch (error) {
      console.error('[kirezi] could not answer call', error)
      showmessage(error.message || 'Could not answer the call.')
      await endCall()
    }
  }

  async function declineCall() {
    const call = current
    if (call && call.role === 'callee') {
      if (call.room) {
        try {
          await call.room.send({ type: 'broadcast', event: 'decline', payload: { callId: call.id } })
        } catch (error) { console.error('[kirezi] decline signal failed', error) }
      }
    }
    cleanup()
  }

  async function handleInvite({ payload }) {
    if (!payload || payload.callee !== me || payload.caller === me || !payload.callId || current) return
    let profile = {}
    try { profile = await getProfile(payload.caller) || {} }
    catch (error) { console.error('[kirezi] incoming call profile lookup failed', error); showmessage('An incoming call could not be displayed.'); return }
    const call = {
      id: payload.callId,
      caller: payload.caller,
      callee: me,
      role: 'callee',
      mode: payload.mode === 'video' ? 'video' : 'audio',
      room: null,
      pc: null,
      local: null,
      remoteCandidates: [],
      pendingLocalCandidates: [],
      roomReady: true
    }
    current = call
    try {
      await openRoom(call)
      if (current !== call) return
      setupPeer(call)
    } catch (error) {
      console.error('[kirezi] incoming call room failed', error)
      showmessage('Could not connect to this call.')
      cleanup()
      return
    }
    showCall(profile || {}, true, call.mode)
    invitationTimer = setTimeout(() => {
      if (current === call) {
        void declineCall()
        showmessage('Missed call')
      }
    }, 35000)
  }

  function init() {
    if (inbox) supabase.removeChannel(inbox)
    inbox = supabase.channel(`kc-call-inbox:${me}`, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'invite' }, handleInvite)
    inboxReady = subscribe(inbox)
    inboxReady.catch(error => console.error('[kirezi] call inbox realtime subscription failed:', error))
  }

  $('callMute').onclick = () => {
    if (!current || !current.local) return
    const track = current.local.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    $('callMute').textContent = track.enabled ? 'Mic on' : 'Muted'
    $('callMute').classList.toggle('off', !track.enabled)
  }
  $('callCamera').onclick = () => {
    if (!current || !current.local) return
    const track = current.local.getVideoTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    $('callCamera').textContent = track.enabled ? 'Camera on' : 'Camera off'
    $('callCamera').classList.toggle('off', !track.enabled)
  }
  $('callOverlay').addEventListener('click', () => {
    const audio = $('callRemoteAudio')
    if (audio.srcObject) audio.play().catch(error => console.error('[kirezi] remote call audio playback failed', error))
  })
  init()
  Object.assign(window, {
    startCall,
    acceptCall: answerCall,
    declineCall,
    endCall,
    toggleCallMute: $('callMute').onclick,
    toggleCallCamera: $('callCamera').onclick
  })
  return { close: () => { void endCall(); if (inbox) supabase.removeChannel(inbox) } }
}
