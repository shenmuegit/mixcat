import os
import hashlib
import hmac
import json
import uuid
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = './web'
NODE_CLASS_MAPPINGS = {}

_secret = os.environ.pop('MIXCAT_COMFY_ADMISSION_SECRET', '')
_instance = os.environ['MIXCAT_COMFY_INSTANCE_ID']
_consumed = set()


@web.middleware
async def admission(request, handler):
    if request.method != 'POST' or request.path not in ('/prompt', '/api/prompt'):
        return await handler(request)
    body = await request.read()
    signature = hmac.new(_secret.encode(), _instance.encode() + b'\n' + body, hashlib.sha256).hexdigest()
    if not _secret or not hmac.compare_digest(signature, request.headers.get('X-Mixcat-Admission', '')):
        return web.json_response({'error': 'Mixcat admission required'}, status=403)
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
