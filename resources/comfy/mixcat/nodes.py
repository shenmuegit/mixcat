import asyncio
import json
import os
import hashlib
from pathlib import Path
import uuid
import urllib.request
import numpy as np
import torch
from PIL import Image
import folder_paths
from comfy_api.latest import ComfyExtension, InputImpl, io
from comfy_execution.utils import get_executing_context

_origin = os.environ.pop('MIXCAT_COMFY_BROKER_ORIGIN', '')
_token = os.environ.pop('MIXCAT_COMFY_BROKER_TOKEN', '')
_instance = os.environ.get('MIXCAT_COMFY_INSTANCE_ID', '')


def request(path, body=None, artifact=None):
    context = get_executing_context()
    headers = {'Authorization': 'Bearer ' + _token, 'X-Mixcat-Instance': _instance,
               'Content-Type': 'application/json'}
    if context:
        headers['X-Mixcat-Prompt'] = context.prompt_id
    if not _origin or not _token:
        raise RuntimeError('Mixcat provider broker unavailable')
    req = urllib.request.Request(_origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            if artifact is not None:
                destination = Path(folder_paths.get_temp_directory()) / ('mixcat-' + artifact['id'] + Path(artifact['relativePath']).suffix)
                digest = hashlib.sha256()
                size = 0
                try:
                    with destination.open('wb') as output:
                        while chunk := response.read(1024 * 1024):
                            size += len(chunk)
                            if size > artifact['bytes'] or size > 512 * 1024 * 1024:
                                raise ValueError('Artifact exceeds size')
                            digest.update(chunk)
                            output.write(chunk)
                    if size != artifact['bytes'] or digest.hexdigest() != artifact['sha256']:
                        raise ValueError('Artifact integrity check failed')
                    return str(destination)
                except Exception:
                    destination.unlink(missing_ok=True)
                    raise
            return json.load(response)
    except Exception:
        raise RuntimeError('Mixcat provider broker request failed') from None


def connections():
    if not _origin:
        return ['unavailable']
    return [item['id'] + '@' + str(item['revision']) for item in request('/v1/connections')] or ['unavailable']


def references(images):
    if images is None:
        return []
    result = []
    for image in images:
        name = 'mixcat-' + str(uuid.uuid4()) + '.png'
        path = Path(folder_paths.get_input_directory()) / name
        Image.fromarray(np.clip(image.cpu().numpy() * 255, 0, 255).astype(np.uint8)).save(path)
        result.append(request('/v1/artifacts', {'relativePath': str(path.relative_to(Path(os.environ['MIXCAT_COMFY_PROJECT_ROOT'])))}))
    return result


async def run_job(kind, connection, model, prompt, parameters, images=None, mode='text'):
    context = get_executing_context()
    if context is None:
        raise RuntimeError('Accepted native execution context required')
    connection_id, revision = connection.rsplit('@', 1)
    payload = {'instanceId': _instance, 'promptId': context.prompt_id, 'nodeId': context.node_id,
               'sequence': context.list_index or 0, 'connectionId': connection_id,
               'connectionRevision': int(revision), 'kind': kind, 'model': model,
               'mode': mode, 'prompt': prompt, 'parameters': json.loads(parameters)}
    if images is not None:
        payload['references'] = await asyncio.to_thread(references, images)
    job = await asyncio.to_thread(request, '/v1/jobs', payload)
    try:
        from comfy.model_management import throw_exception_if_processing_interrupted
        while True:
            throw_exception_if_processing_interrupted()
            result = await asyncio.to_thread(request, '/v1/jobs/' + job['jobId'])
            if not result['waiting']:
                raise RuntimeError('Mixcat provider wait stopped')
            if result['status'] == 'succeeded':
                return result
            if result['status'] in ('failed', 'cancelled', 'submission_unknown', 'needs_reconciliation'):
                raise RuntimeError('Mixcat provider job ' + result['status'])
            await asyncio.sleep(0.25)
    except BaseException:
        try:
            await asyncio.shield(asyncio.to_thread(request, '/v1/jobs/' + job['jobId'] + '/stop', {'action': 'stop_waiting'}))
        except Exception:
            pass
        raise


class _MixcatNode(io.ComfyNode):
    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        context = get_executing_context()
        return (context.prompt_id if context else float('nan'), kwargs.get('connection'))


class MixcatAPIText(_MixcatNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='MixcatAPIText', display_name='Mixcat API Text', category='Mixcat/API',
                         inputs=[io.Combo.Input('connection', options=connections()),
                                 io.String.Input('model', default=''),
                                 io.String.Input('prompt', multiline=True),
                                 io.String.Input('parameters', default='{}', multiline=True)],
                         outputs=[io.String.Output()])

    @classmethod
    async def execute(cls, connection, model, prompt, parameters):
        result = await run_job('text', connection, model, prompt, parameters)
        return io.NodeOutput(result['text'])


class MixcatAPIImage(_MixcatNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='MixcatAPIImage', display_name='Mixcat API Image', category='Mixcat/API',
                         inputs=[io.Combo.Input('connection', options=connections()),
                                 io.String.Input('model', default=''), io.String.Input('prompt', multiline=True),
                                 io.String.Input('parameters', default='{}', multiline=True),
                                 io.Image.Input('images', optional=True)], outputs=[io.Image.Output()])

    @classmethod
    async def execute(cls, connection, model, prompt, parameters, images=None):
        mode = 'text' if images is None else 'reference' if len(images) > 1 else 'image'
        result = await run_job('image', connection, model, prompt, parameters, images, mode)
        decoded = []
        for artifact in result['assets']:
            path = await asyncio.to_thread(request, '/v1/artifacts/' + artifact['id'], None, artifact)
            with Image.open(path) as image:
                decoded.append(torch.from_numpy(np.array(image.convert('RGB')).astype(np.float32) / 255.0).unsqueeze(0))
        return io.NodeOutput(torch.cat(decoded, dim=0))


class MixcatAPIVideo(_MixcatNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='MixcatAPIVideo', display_name='Mixcat API Video', category='Mixcat/API',
                         inputs=[io.Combo.Input('connection', options=connections()),
                                 io.String.Input('model', default=''), io.String.Input('prompt', multiline=True),
                                 io.Combo.Input('mode', options=['text', 'image', 'reference']),
                                 io.String.Input('parameters', default='{}', multiline=True),
                                 io.Image.Input('images', optional=True)], outputs=[io.Video.Output()])

    @classmethod
    async def execute(cls, connection, model, prompt, mode, parameters, images=None):
        result = await run_job('video', connection, model, prompt, parameters, images, mode)
        artifact = result['assets'][0]
        path = await asyncio.to_thread(request, '/v1/artifacts/' + artifact['id'], None, artifact)
        return io.NodeOutput(InputImpl.VideoFromFile(path))


class MixcatExtension(ComfyExtension):
    async def get_node_list(self):
        return [MixcatAPIText, MixcatAPIImage, MixcatAPIVideo]


async def comfy_entrypoint():
    return MixcatExtension()
