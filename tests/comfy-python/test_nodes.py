import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

root = Path(sys.argv.pop(1))
sys.path.insert(0, str(root / '.mixcat/comfy/runtime/comfy043-py31410-cpu1/backend'))
spec = importlib.util.spec_from_file_location('mixcat_nodes', root / 'resources/comfy/mixcat/nodes.py')
nodes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodes)
from comfy_execution.utils import CurrentNodeContext


class NativeTypes(unittest.TestCase):
    def test_text_native_schema_and_run_fingerprint(self):
        schema = nodes.MixcatAPIText.define_schema()
        self.assertEqual(schema.node_id, 'MixcatAPIText')
        encoded = str(schema)
        self.assertNotIn('api_key', encoded)
        self.assertNotIn('base_url', encoded)
        with CurrentNodeContext('accepted-prompt', '1', 0):
            self.assertEqual(nodes.MixcatAPIText.fingerprint_inputs(connection='c@2'), ('accepted-prompt', 'c@2'))
        with CurrentNodeContext('another-prompt', '1', 0):
            self.assertEqual(nodes.MixcatAPIText.fingerprint_inputs(connection='c@2'), ('another-prompt', 'c@2'))

    def test_image_native_schema(self):
        nodes.MixcatAPIText.GET_SCHEMA()
        schema = nodes.MixcatAPIImage.GET_SCHEMA()
        self.assertEqual(schema.node_id, 'MixcatAPIImage')
        self.assertEqual(nodes.MixcatAPIText.RETURN_TYPES, ['STRING'])
        self.assertEqual(nodes.MixcatAPIImage.RETURN_TYPES, ['IMAGE'])
        self.assertNotIn('api_key', str(schema))
        self.assertNotIn('base_url', str(schema))

    def test_video_native_schema(self):
        nodes.MixcatAPIVideo.GET_SCHEMA()
        self.assertEqual(nodes.MixcatAPIVideo.RETURN_TYPES, ['VIDEO'])
        self.assertNotIn('api_key', str(nodes.MixcatAPIVideo.define_schema()))
        self.assertNotIn('base_url', str(nodes.MixcatAPIVideo.define_schema()))


if __name__ == '__main__':
    unittest.main()
