import os
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = './web'
NODE_CLASS_MAPPINGS = {}

@PromptServer.instance.routes.get('/mixcat/identity')
async def mixcat_identity(request):
    return web.json_response({'instanceId': os.environ['MIXCAT_COMFY_INSTANCE_ID']})
