import colorsys
import datetime
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
PUBLISHER = ROOT / 'ha/python_scripts/weather_display_publish.py'


def publish(hours, **units):
    hass = SimpleNamespace(states=Mock(), services=Mock())
    hass.states.get.return_value = SimpleNamespace(attributes=units)
    context = dict(data={'forecast_data': {'weather.test': {'forecast': hours}}},
                   hass=hass, logger=Mock(),
                   now=lambda: datetime.datetime(2026, 9, 11, tzinfo=datetime.timezone.utc))
    exec(compile(PUBLISHER.read_text(), str(PUBLISHER), 'exec'), context)
    return context, hass.services.call.call_args_list


class PublisherTest(unittest.TestCase):
    def test_metric_payload_and_padding(self):
        _, calls = publish([dict(temperature=10, condition='rainy', wind_speed=4.4,
                                 precipitation=.02, datetime='2026-09-11T12:00:00Z')],
                           temperature_unit='°C', wind_speed_unit='m/s', precipitation_unit='in')
        self.assertEqual('forecast', calls[0].args[2]['payload'])
        msg = calls[1].args[2]
        self.assertTrue(msg['retain'])
        self.assertEqual('weather/hourly', msg['topic'])
        self.assertEqual([[4, 8, 0, 4, 2, 50.0]] * 24, json.loads(msg['payload'])['h'])

    def test_missing_temperature_and_clear_night(self):
        _, calls = publish([dict(temperature=v, condition='clear-night',
                                datetime='2026-09-11T12:00:00Z')
                            for v in [None, 'bad', float('nan'), float('inf')]])
        hours = json.loads(calls[-1].args[2]['payload'])['h']
        self.assertEqual([[0, 2, 1, 0, 0, None]] * 24, hours)

    def test_probability_precedence_hail_and_unknown(self):
        _, calls = publish([dict(temperature=65.5, condition=condition,
                                precipitation_probability=70, precipitation=0)
                            for condition in ['hail', 'exceptional', 'unrecognized']])
        hours = json.loads(calls[-1].args[2]['payload'])['h']
        self.assertEqual([13, 12, 0], [h[1] for h in hours[:3]])
        self.assertTrue(all(h[3] == 8 and h[5] == 65.5 for h in hours))

    def test_android_bucket_boundaries(self):
        ctx, _ = publish([])
        for value, expected in [(0, 1), (.09, 2), (.1, 3), (.49, 3), (.5, 4),
                                (1, 5), (2, 6), (4, 7), (8, 8), (16, 9), (32, 10)]:
            self.assertEqual(expected, ctx['precip_bucket_mm'](value))
        for value, expected in [(0, 1), (4.9, 1), (5, 2), (9.9, 2), (10, 3),
                                (14.9, 3), (15, 4), (19.9, 4), (20, 5),
                                (29.9, 5), (30, 6), (39.9, 6), (40, 7), (50, 8)]:
            self.assertEqual(expected, ctx['wind_bucket_mph'](value))

    def test_empty_forecast_does_not_publish(self):
        _, calls = publish([])
        self.assertEqual([], calls)


class FirmwareColorsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.binary = str(Path(cls.tmp.name) / 'colors')
        subprocess.run([shutil.which('c++') or 'c++', '-std=c++11', '-Wall', '-Wextra',
                        '-Werror', '-I' + str(ROOT / 'include'),
                        '-I' + str(ROOT / '.pio/libdeps/esp32dev/ArduinoJson/src'),
                        str(ROOT / 'tests/colors.cpp'), '-o', cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_temperature_and_legacy_protocol(self):
        subprocess.run([self.binary], check=True)

    def test_wet_colors_against_independent_hsl_reference(self):
        output = subprocess.check_output([self.binary, 'wet'], text=True)
        actual = [int(line, 16) for line in output.splitlines()]
        expected = []
        for base in [0x43C47E, 0x9BE0E8, 0xA66BFF]:
            rgb = [((base >> shift) & 255) / 255 for shift in (16, 8, 0)]
            hue, _, _ = colorsys.rgb_to_hls(*rgb)
            for saturation, lightness in [(1, .74), (.73, .38), (.59, .21)]:
                color = colorsys.hls_to_rgb(hue, lightness, saturation)
                expected.append(sum(round(c * 255) << shift
                                    for c, shift in zip(color, (16, 8, 0))))
        self.assertEqual(expected, actual)
