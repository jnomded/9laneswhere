"""
Script to update labels.csv based on actual file locations.
Checks if files are in track/ or not_track/ folder and updates
the filepath and kind columns accordingly.
- Files in track/ get kind="positive"
- Files in not_track/ get kind="hard_negative"
"""

import os
import pandas as pd

# Define paths simply
FILE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.abspath(os.path.join(FILE_DIR, '..', '..', 'dataset_osm'))
LABELS_FILE = os.path.join(BASE_DIR, 'labels.csv')
TRACK_FOLDER = os.path.join(BASE_DIR, 'track')
NOT_TRACK_FOLDER = os.path.join(BASE_DIR, 'not_track')

def update_labels():
    print("Reading CSV file...")
    df = pd.read_csv(LABELS_FILE)
    
    count = 0
    
    # Loop through every row in the dataframe using the index
    for i in range(len(df)):
        # Get the full path currently in the csv
        old_path = df.loc[i, 'filepath']
        
        # Get just the name of the file
        filename = os.path.basename(str(old_path))
        
        # Check if it is in the track folder
        path_in_track = os.path.join(TRACK_FOLDER, filename)
        path_in_not_track = os.path.join(NOT_TRACK_FOLDER, filename)
        
        if os.path.exists(path_in_track):
            # It is a track
            df.loc[i, 'filepath'] = 'track/' + filename
            df.loc[i, 'kind'] = 'positive'
            df.loc[i, 'label'] = 1
            count = count + 1
            
        elif os.path.exists(path_in_not_track):
            # It is not a track
            df.loc[i, 'filepath'] = 'not_track/' + filename
            df.loc[i, 'kind'] = 'hard_negative'
            df.loc[i, 'label'] = 0
            count = count + 1
            
        else:
            print("Could not find file: " + filename)

    # Save the file back
    df.to_csv(LABELS_FILE, index=False)
    print(f"Finished. Updated {count} rows.")

if __name__ == '__main__':
    update_labels()
