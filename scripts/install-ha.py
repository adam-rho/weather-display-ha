"""Install the card on a storage-mode dashboard through an existing SSH connection.

Stops HA only for the dashboard/resource update, after checking new YAML.
Never modifies storage files while HA is running. Original files are backed up.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True, help='Existing SSH user@host')
    parser.add_argument('--dashboard', required=True, help='Storage suffix, e.g. dashboard_desktop')
    parser.add_argument('--install', action='store_true', help='Without this flag, only describe the change')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.dashboard):
        parser.error('Invalid dashboard storage name')
    if args.host.startswith('-'):
        parser.error('Invalid SSH host')

    def ssh(command, data=None):
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                 args.host, command], input=data, capture_output=True, check=True)
        return result.stdout

    def read(path):
        return ssh('cat '+shlex.quote(path))

    def write(path, content):
        target = shlex.quote(path)
        ssh('umask 077; cat > '+target+'.new && mv '+target+'.new '+target, content)
        if hashlib.sha256(read(path)).digest() != hashlib.sha256(content).digest():
            raise RuntimeError('Installed checksum mismatch: '+path)

    dashboard_path = '/config/.storage/lovelace.'+args.dashboard
    resource_path = '/config/.storage/lovelace_resources'
    config_path = '/config/configuration.yaml'
    scripts_path = '/config/scripts.yaml'
    original_config = read(config_path)
    original_scripts = read(scripts_path)
    dashboard = json.loads(read(dashboard_path))
    titles = [v.get('title') for v in dashboard['data']['config']['views']]
    print('Existing dashboard tabs:', ', '.join(titles), flush=True)
    config = original_config.decode()
    include = '    edgelight_editor: !include edgelight-editor.yaml'
    if include not in config:
        if re.search(r'^homeassistant\s*:', config, re.M):
            raise RuntimeError('Existing homeassistant section: add the edgelight_editor package include there before installing.')
        config += '\n# Edgelight display editor\nhomeassistant:\n  packages:\n'+include+'\n'
    scripts = original_scripts.decode()
    start = scripts.index('weather_display_update:')
    following = re.search(r'^\S[^\n]*:', scripts[start+len('weather_display_update:'):], re.M)
    end = start+len('weather_display_update:')+following.start() if following else len(scripts)
    block = scripts[start:end]
    if 'generated_at:' not in block:
        block, count = re.subn(r'(?m)^(\s*)forecast_data:([^\n]*)$',
                              r'\1forecast_data:\2\n\1generated_at: "{{ now().isoformat() }}"', block)
        if count != 1:
            raise RuntimeError('Could not identify forecast publisher data; refusing to edit scripts.')
        scripts = scripts[:start]+block+scripts[end:]
    print('Will add the Edgelight tab, register its resource, and install the MQTT settings package.', flush=True)
    if not args.install:
        return

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = '/config/edgelight-backups/'+stamp
    asset_dir = '/config/www/edgelight/'+stamp
    ssh('mkdir -p '+shlex.quote(backup)+' '+shlex.quote(asset_dir)+' && chmod 700 '+shlex.quote(backup))
    originals = {config_path:original_config, scripts_path:original_scripts}
    for path in ['/config/edgelight-editor.yaml','/config/python_scripts/weather_display_publish.py']:
        try:
            originals[path]=read(path)
        except subprocess.CalledProcessError:
            pass
    for path, content in originals.items():
        write(backup+'/'+Path(path).name, content)
    stopped = False
    try:
        for filename in ['edgelight-card.js','display-model.js','edgelight.css']:
            write(asset_dir+'/'+filename, (ROOT/'dist'/filename).read_bytes())
        write('/config/edgelight-editor.yaml', (ROOT/'ha/display-editor.yaml').read_bytes())
        write('/config/python_scripts/weather_display_publish.py', (ROOT/'ha/python_scripts/weather_display_publish.py').read_bytes())
        write(config_path, config.encode())
        write(scripts_path, scripts.encode())
        print('Checking Home Assistant configuration...', flush=True)
        ssh('ha core check')
        print('Stopping Home Assistant briefly to add the dashboard tab...', flush=True)
        ssh('ha core stop'); stopped=True
        # Read fresh storage after shutdown; preserve any edits made during preparation.
        originals[dashboard_path]=read(dashboard_path)
        originals[resource_path]=read(resource_path)
        for path in [dashboard_path, resource_path]:
            write(backup+'/'+Path(path).name, originals[path])
        dashboard=json.loads(originals[dashboard_path]); resources=json.loads(originals[resource_path])
        views=dashboard['data']['config']['views']
        view=json.loads((ROOT/'ha/display-editor-view.json').read_text())
        existing=next((i for i,v in enumerate(views) if v.get('path')=='edgelight'),None)
        if existing is None: views.append(view)
        else: views[existing]=view
        items=resources['data']['items']
        item=next((v for v in items if v.get('id')=='edgelight-display-editor'),None)
        if item is None:
            item={'id':'edgelight-display-editor'};items.append(item)
        item.update(url='/local/edgelight/'+stamp+'/edgelight-card.js',type='module')
        write(dashboard_path,json.dumps(dashboard,ensure_ascii=False,indent=2).encode())
        write(resource_path,json.dumps(resources,ensure_ascii=False,indent=2).encode())
        print('Starting Home Assistant...',flush=True)
        ssh('ha core start');stopped=False
        print('Installed. Original configuration backup:',backup,flush=True)
    except Exception:
        for path,content in originals.items():
            # Storage backups only exist after a successful stop.
            write(path,content)
        raise
    finally:
        if stopped:
            ssh('ha core start')


if __name__ == '__main__':
    main()
