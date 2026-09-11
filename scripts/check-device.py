"""Read device state, or verify an idempotent Apply without changing its settings.

Uses the existing firmware MQTT credentials without printing them.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--apply-current',action='store_true')
    args=parser.parse_args()
    secrets=(ROOT/'include/secrets.h').read_text()
    values=dict(re.findall(r'^#define\s+(MQTT_\w+)\s+"([^"]*)"',secrets,re.M))
    connection=['-h',values['MQTT_HOST'],'-u',values['MQTT_USER'],'-P',values['MQTT_PASS']]

    def read(topic):
        result=subprocess.run(['mosquitto_sub',*connection,'-t',topic,'-C','1','-W','10'],capture_output=True)
        if result.returncode:
            raise RuntimeError('No MQTT message received on '+topic)
        return result.stdout.decode().strip()

    state=json.loads(read('weather/display/config/state'))
    forecast=json.loads(read('weather/hourly'))
    print('Device:',read('weather/display/availability'))
    print('Configuration revision:',state['revision'])
    print('Rows:',state['config']['top'], '/',state['config']['bottom'])
    print('Forecast hours:',len(forecast['h']),'; tuple fields:',len(forecast['h'][0]))
    print('Forecast generation time:',forecast.get('generated_at'))
    if args.apply_current:
        command={'id':str(uuid.uuid4()),'expectedRevision':state['revision'],'config':state['config']}
        for attempt in range(2):
            subprocess.run(['mosquitto_pub',*connection,'-t','weather/display/config/set','-q','1','-s'],
                           input=json.dumps(command).encode(),check=True,capture_output=True)
            # State publication follows processing; poll retained state with bounded retries.
            for _ in range(10):
                updated=json.loads(read('weather/display/config/state'))
                if updated['requestId']==command['id']:
                    break
                time.sleep(.5)
            assert updated['requestId']==command['id'], 'Device did not confirm Apply'
            assert updated['revision']==state['revision']+1, 'Retry changed revision'
            assert updated['config']==state['config'], 'Apply changed configuration unexpectedly'
        print('Device confirmed Apply and retry exactly once; configuration unchanged.')


if __name__=='__main__':
    main()
