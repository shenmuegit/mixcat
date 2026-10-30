import os
import hashlib
import hmac
import json
import uuid
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = './web'
from .nodes import comfy_entrypoint

_secret = os.environ.pop('MIXCAT_COMFY_ADMISSION_SECRET', '')
_instance = os.environ['MIXCAT_COMFY_INSTANCE_ID']
_consumed = set()


@web.middleware
async def admission(request, handler):
    if request.method != 'POST' or request.path not in ('/prompt', '/api/prompt', '/mixcat/stop', '/api/mixcat/stop', '/mixcat/connections-changed', '/api/mixcat/connections-changed'):
        return await handler(request)
    body = await request.read()
    signature = hmac.new(_secret.encode(), _instance.encode() + b'\n' + body, hashlib.sha256).hexdigest()
    if not _secret or not hmac.compare_digest(signature, request.headers.get('X-Mixcat-Admission', '')):
        return web.json_response({'error': 'Mixcat admission required'}, status=403)
    if '/mixcat/' in request.path:
        return await handler(request)
    try:
        payload = json.loads(body)
        prompt_id = payload['prompt_id']
        if str(uuid.UUID(prompt_id)) != prompt_id:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        return web.json_response({'error': 'Assigned canonical prompt_id required'}, status=400)
    if prompt_id in _consumed:
        return web.json_response({'error': 'Prompt admission already consumed'}, status=409)
    # Consume before handler validation/await: backend prompt_id itself does not deduplicate.
    _consumed.add(prompt_id)
    return await handler(request)


PromptServer.instance.app.middlewares.append(admission)

@PromptServer.instance.routes.get('/mixcat/identity')
async def mixcat_identity(request):
    return web.json_response({'instanceId': _instance, 'admission': True})


@PromptServer.instance.routes.post('/mixcat/stop')
async def mixcat_stop(request):
    prompt_id = (await request.json()).get('prompt_id')
    if prompt_id not in _consumed:
        return web.json_response({'error': 'Accepted prompt required'}, status=400)
    queue = PromptServer.instance.prompt_queue
    removed = queue.delete_queue_item(lambda item: item[1] == prompt_id)
    interrupted = queue.interrupt_if_running(prompt_id)
    return web.json_response({'removed': bool(removed), 'interrupted': interrupted})


@PromptServer.instance.routes.post('/mixcat/connections-changed')
async def mixcat_connections_changed(request):
    PromptServer.instance.send_sync('mixcat.connections', {})
    return web.json_response({'ok': True})
