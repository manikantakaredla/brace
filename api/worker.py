import argparse
from .engine import init,worker
p=argparse.ArgumentParser()
p.add_argument('run_id');p.add_argument('--delay',type=float,default=.5)
a=p.parse_args();init();worker(a.run_id,a.delay)
